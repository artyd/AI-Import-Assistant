import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { MODEL } from '../anthropic/client.js';
import { createRedis } from '../queue/connection.js';
import { INDEX_QUEUE, type IndexJobData } from '../queue/index.js';
import { REMINDERS_QUEUE, scheduleReminders, type ReminderJobData } from '../queue/reminders.js';
import { NEWS_QUEUE, scheduleNews, type NewsJobData } from '../queue/news.js';
import {
  INGEST_RETRY_QUEUE,
  scheduleIngestRetry,
  type IngestRetryJobData,
} from '../queue/ingestRetry.js';
import { sweepStuckFiles } from '../services/ingestRetry.js';
import { readStoredFile } from '../services/storage.js';
import { convertToMarkdown } from '../services/markdown/convert.js';
import { saveFileMarkdown } from '../services/markdown/store.js';
import {
  extractFieldsFromMarkdown,
  extractDocumentFieldsFromDocumentWithMeta,
  type ExtractedFields,
} from '../services/extraction/extractFields.js';
import { classifyAndFile } from '../services/classify.js';
import { getWorkspaceById } from '../services/workspaceAccess.js';
import { refreshWorkspaceState } from '../services/status.js';
import { autoFillWorkspaceContext } from '../services/autoContext.js';
import { computeRisks } from '../services/risks.js';
import { maybeReconcileBatch } from '../services/reconcileBatch.js';
import { insertNotification } from '../services/notifications.js';
import { scanAndNotify } from '../services/reminders.js';
import { ingestNews, purgeOldNews } from '../services/news/index.js';
import { publishFileStatus } from '../events/fileStatus.js';
import type { FileType } from '../domain/folders.js';

interface FileJobRow {
  id: string;
  workspace_id: string;
  name: string;
  type: FileType;
  disk_path: string;
  folder_name: string | null;
  batch_id: string | null;
}

/**
 * True when an extraction carries at least one real signal. A forced-tool call
 * (tool_choice) essentially always returns a non-null object, so "vision produced
 * garbage/near-empty" was previously indistinguishable from "good data" and got
 * marked `ok`. This gate downgrades an all-null extraction to no_fields/unreadable
 * so it reaches the manual-verification screen instead of silently looking read.
 */
function extractionIsSubstantive(f: ExtractedFields): boolean {
  const backbone = [
    f.invoice_number, f.contract_number, f.po_number, f.total_value, f.currency,
    f.hs_code, f.country_of_origin, f.buyer, f.seller, f.incoterm, f.manufacturer,
    f.registration_number, f.document_date, f.net_weight_kg, f.gross_weight_kg,
    f.total_weight_kg, f.packages_count,
  ];
  const hasBackbone = backbone.some((v) => v !== null && v !== undefined && v !== '');
  const hasLines = Array.isArray(f.line_items) && f.line_items.length > 0;
  const hasParties = Array.isArray(f.parties) && f.parties.length > 0;
  const hasDocType = !!f.doc_type && f.doc_type !== 'other';
  return hasBackbone || hasLines || hasParties || hasDocType;
}

async function setStatus(
  fileId: string,
  workspaceId: string,
  status: 'indexing' | 'ready' | 'error',
  errorReason: string | null = null,
): Promise<void> {
  await query('UPDATE files SET status = $2, error_reason = $3 WHERE id = $1', [
    fileId,
    status,
    errorReason,
  ]);
  await publishFileStatus(workspaceId, { fileId, status, errorReason });
}

async function processJob(job: Job<IndexJobData>): Promise<void> {
  const { fileId } = job.data;
  const { rows } = await query<FileJobRow>(
    `SELECT f.id, f.workspace_id, f.name, f.type, f.disk_path, f.batch_id, fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.id = $1`,
    [fileId],
  );
  const file = rows[0];
  if (!file) return; // File deleted before indexing ran.

  await setStatus(file.id, file.workspace_id, 'indexing');

  try {
    const buf = await readStoredFile(file.disk_path);

    // Ingest-time Markdown: Claude vision transcribes PDFs/scans/photos in page
    // windows (tables → Markdown tables, real page numbers); docx/xlsx/csv are
    // converted locally; legacy .doc goes through LibreOffice. Stored once and
    // read by read_file, extraction, classification and full-text search — there
    // is no embedding vendor in the pipeline any more.
    const conv = await convertToMarkdown(buf, file.type, file.name);
    await saveFileMarkdown(file.id, file.workspace_id, conv);
    const pages = conv.pages;
    // eslint-disable-next-line no-console
    console.log(
      `Converted ${file.id} (${file.name}) → Markdown via ${conv.converter}: ` +
        `${pages.length} page(s), ${pages.reduce((n, p) => n + p.markdown.length, 0)} chars` +
        `${conv.partial ? ' [PARTIAL]' : ''}${conv.note ? ` — ${conv.note}` : ''}.`,
    );

    await setStatus(file.id, file.workspace_id, 'ready');

    // Structured extraction (best-effort): populate document_extractions so the
    // checklist/discrepancy checks are deterministic. A failure here must NOT
    // fail indexing — the file stays "ready".
    if (config.EXTRACTION_ENABLED) {
      try {
        await query('DELETE FROM document_extractions WHERE file_id = $1', [file.id]);
        // Primary: multi-pass extraction over the stored Markdown (already a
        // faithful Claude transcription, so no second vision pass is needed).
        // Fallback: direct vision on the original file when no Markdown came out.
        let meta: { fields: ExtractedFields | null; truncated: boolean } =
          pages.length > 0 ? await extractFieldsFromMarkdown(pages) : { fields: null, truncated: false };
        if (!meta.fields && (file.type === 'pdf' || file.type === 'image')) {
          meta = await extractDocumentFieldsFromDocumentWithMeta(buf, file.type, file.name);
        }
        if (conv.partial) meta.truncated = true;
        const fields = meta.fields;

        if (fields && extractionIsSubstantive(fields)) {
          await query(
            `INSERT INTO document_extractions (file_id, workspace_id, extracted_fields, model_version)
             VALUES ($1, $2, $3::jsonb, $4)`,
            [file.id, file.workspace_id, JSON.stringify(fields), MODEL],
          );
          // 'partial' when the extraction JSON was truncated by the output cap:
          // fields are present but line_items are under-counted — don't trust as
          // a clean 'ok' (reconciliation/totals may be incomplete).
          await query('UPDATE files SET extraction_status = $2 WHERE id = $1', [
            file.id,
            meta.truncated ? 'partial' : 'ok',
          ]);
          if (meta.truncated) {
            // eslint-disable-next-line no-console
            console.warn(`Extraction TRUNCATED (max_tokens) for file ${file.id} (${file.name}); stored as partial.`);
          }
        } else if (pages.length === 0) {
          // Honest unreadable status (plan Q29): the document could not be read.
          // Insert a flagged placeholder extraction so the verification screen
          // surfaces it and asks the human to enter key fields — never a silent skip.
          const placeholder = {
            doc_type: 'other',
            also_contains: [],
            unreadable: true,
            extraction_note:
              conv.note ??
              'Документ не вдалося прочитати (скан без текстового шару / OCR не дав результату). ' +
                'Введіть ключові поля вручну.',
          };
          await query(
            `INSERT INTO document_extractions (file_id, workspace_id, extracted_fields, model_version)
             VALUES ($1, $2, $3::jsonb, $4)`,
            [file.id, file.workspace_id, JSON.stringify(placeholder), MODEL],
          );
          await query('UPDATE files SET extraction_status = $2 WHERE id = $1', [file.id, 'unreadable']);
        } else {
          await query('UPDATE files SET extraction_status = $2 WHERE id = $1', [file.id, 'no_fields']);
        }
        const ws = await getWorkspaceById(file.workspace_id);
        if (ws) {
          await refreshWorkspaceState(ws);
          // AUTOPILOT: persist document-derived context (parties, contract_type,
          // Incoterms, origin) so the agent/sidebar don't ask for what the docs
          // already state. NULL-only + manual-lock-respecting; best-effort.
          try {
            await autoFillWorkspaceContext(ws.id);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`Auto-fill context failed for workspace ${ws.id}:`, (err as Error).message);
          }
          // Proactive risk scan: notify the responsible user about NEW critical
          // (error-level) risks. De-duped per (user, workspace, type) per day.
          if (ws.responsible_user_id) {
            try {
              const risks = await computeRisks(ws);
              const critical = risks.filter((r) => r.severity === 'error');
              if (critical.length > 0) {
                await insertNotification(
                  ws.responsible_user_id,
                  ws.id,
                  'risk_alert',
                  `Постачання №${ws.number}: критичні ризики (${critical.length}) — ${critical[0]!.title}.`,
                );
              }
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(`Risk scan failed for workspace ${ws.id}:`, (err as Error).message);
            }
          }
        }

        // Auto-file the document into its skeleton folder using the CLAUDE
        // classifier (structured extraction → filename heuristic → LLM-on-Markdown). High/medium confidence
        // moves the file; low confidence stays in the inbox with a suggestion for
        // the user to confirm. Guarded on folder_id IS NULL so we never touch a
        // file the user already placed by hand.
        const { rows: cur } = await query<{ folder_id: string | null }>(
          'SELECT folder_id FROM files WHERE id = $1',
          [file.id],
        );
        if (cur[0] && cur[0].folder_id === null) {
          const res = await classifyAndFile(file.workspace_id, file.id, { move: true });
          if (res?.to) {
            // eslint-disable-next-line no-console
            console.log(`Auto-filed ${file.id} (${file.name}) → ${res.to}.`);
          } else if (res?.suggested) {
            // eslint-disable-next-line no-console
            console.log(`Suggested folder for ${file.id} (${file.name}) → ${res.suggested} (needs confirm).`);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`Extraction failed for file ${file.id}:`, (err as Error).message);
      }
    }

    // This file is now terminal (ready). If it was the last of its upload batch,
    // fire the deterministic auto-reconcile. Best-effort — never fail the job.
    try {
      await maybeReconcileBatch(file.batch_id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Batch reconcile check failed for file ${file.id}:`, (err as Error).message);
    }
  } catch (err) {
    const reason = (err as Error).message?.slice(0, 300) ?? 'unknown error';
    await setStatus(file.id, file.workspace_id, 'error', reason);
    throw err; // Let BullMQ record the failure / retry.
  }
}

/**
 * Daily reminder scan: for every workspace with a responsible user and at least
 * one still-missing required checklist item, insert a (de-duped) in-app
 * notification. In-app only — the stack has no email/SMTP provider.
 */
async function processReminders(_job: Job<ReminderJobData>): Promise<void> {
  const n = await scanAndNotify();
  // eslint-disable-next-line no-console
  console.log(`Reminder scan: ${n} notification(s) inserted.`);
}

/**
 * News ingest: fetch every configured RSS/Atom feed, upsert new items, then purge
 * anything older than NEWS_RETENTION_DAYS. Individual feed failures are tolerated
 * inside ingestNews — the job always completes.
 */
async function processNews(_job: Job<NewsJobData>): Promise<void> {
  const { inserted, ok, failed } = await ingestNews();
  const purged = await purgeOldNews();
  // eslint-disable-next-line no-console
  console.log(
    `News ingest: +${inserted} new item(s) from ${ok} feed(s) (${failed} failed), ${purged} purged.`,
  );
}

/**
 * Auto-retry sweep: re-queue files stuck in 'error' up to INGEST_MAX_RETRIES,
 * then flag the persistent ones for manual entry. See services/ingestRetry.
 */
async function processIngestRetry(_job: Job<IngestRetryJobData>): Promise<void> {
  const { requeued, flagged } = await sweepStuckFiles();
  if (requeued > 0 || flagged > 0) {
    // eslint-disable-next-line no-console
    console.log(`Ingest retry sweep: re-queued ${requeued}, flagged ${flagged} for manual entry.`);
  }
}

async function main(): Promise<void> {
  await runMigrations();

  const worker = new Worker<IndexJobData>(INDEX_QUEUE, processJob, {
    connection: createRedis(),
    concurrency: config.INDEX_CONCURRENCY,
    // Coarse job-rate guard so a huge upload drains steadily. The finer control
    // on external-AI fan-out is the Anthropic concurrency semaphore (see
    // src/anthropic/limiter.ts) applied inside OCR + extraction.
    limiter: { max: config.INDEX_RATE_MAX, duration: config.INDEX_RATE_DURATION_MS },
  });

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`Indexing job ${job?.id} failed:`, err.message);
  });

  // Daily reminders (in-app). Optional — gated by REMINDERS_ENABLED.
  let remindersWorker: Worker<ReminderJobData> | null = null;
  if (config.REMINDERS_ENABLED) {
    await scheduleReminders();
    remindersWorker = new Worker<ReminderJobData>(REMINDERS_QUEUE, processReminders, {
      connection: createRedis(),
    });
    remindersWorker.on('failed', (job, err) => {
      // eslint-disable-next-line no-console
      console.error(`Reminder job ${job?.id} failed:`, err.message);
    });
  }

  // News ingest (RSS → news_items). Optional — gated by NEWS_ENABLED.
  let newsWorker: Worker<NewsJobData> | null = null;
  if (config.NEWS_ENABLED) {
    await scheduleNews();
    newsWorker = new Worker<NewsJobData>(NEWS_QUEUE, processNews, {
      connection: createRedis(),
    });
    newsWorker.on('failed', (job, err) => {
      // eslint-disable-next-line no-console
      console.error(`News job ${job?.id} failed:`, err.message);
    });
  }

  // Auto-retry sweep (error files → re-queue / flag). Gated by INGEST_RETRY_ENABLED.
  let ingestRetryWorker: Worker<IngestRetryJobData> | null = null;
  if (config.INGEST_RETRY_ENABLED) {
    await scheduleIngestRetry();
    ingestRetryWorker = new Worker<IngestRetryJobData>(INGEST_RETRY_QUEUE, processIngestRetry, {
      connection: createRedis(),
    });
    ingestRetryWorker.on('failed', (job, err) => {
      // eslint-disable-next-line no-console
      console.error(`Ingest retry job ${job?.id} failed:`, err.message);
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `Indexing worker started (env=${config.NODE_ENV}, concurrency=${config.INDEX_CONCURRENCY}, ` +
      `anthropicMaxConcurrency=${config.ANTHROPIC_MAX_CONCURRENCY}, extraction=${config.EXTRACTION_ENABLED}, ` +
      `ocr=${config.OCR_ENABLED}, reminders=${config.REMINDERS_ENABLED}, news=${config.NEWS_ENABLED}, ` +
      `ingestRetry=${config.INGEST_RETRY_ENABLED}).`,
  );

  const shutdown = async (): Promise<void> => {
    await worker.close();
    if (remindersWorker) await remindersWorker.close();
    if (newsWorker) await newsWorker.close();
    if (ingestRetryWorker) await ingestRetryWorker.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Worker fatal boot error', err);
  process.exit(1);
});
