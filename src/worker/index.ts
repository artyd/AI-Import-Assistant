import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { MODEL } from '../anthropic/client.js';
import { createRedis } from '../queue/connection.js';
import { INDEX_QUEUE, type IndexJobData } from '../queue/index.js';
import { REMINDERS_QUEUE, scheduleReminders, type ReminderJobData } from '../queue/reminders.js';
import { NEWS_QUEUE, scheduleNews, type NewsJobData } from '../queue/news.js';
import { TRACKING_QUEUE, scheduleTracking, type TrackingJobData } from '../queue/tracking.js';
import { SHEET_QUEUE, scheduleSheetSync, type SheetJobData } from '../queue/sheet.js';
import { sheetEnabled, syncSheet } from '../services/sheet/sync.js';
import { refreshDue } from '../services/hub/track.js';
import { scanNewsForHubStatus } from '../services/hub/portNews.js';
import { seedPlaces } from '../services/hub/ports.js';
import { startAis, stopAis, aisEnabled } from '../services/hub/ais.js';
import {
  INGEST_RETRY_QUEUE,
  scheduleIngestRetry,
  type IngestRetryJobData,
} from '../queue/ingestRetry.js';
import { sweepStuckFiles } from '../services/ingestRetry.js';
import { readStoredFile } from '../services/storage.js';
import { convertToMarkdown, type ConversionResult } from '../services/markdown/convert.js';
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
  content_hash: string | null;
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
  await query('UPDATE files SET status = $2, error_reason = $3, status_changed_at = now() WHERE id = $1', [
    fileId,
    status,
    errorReason,
  ]);
  await publishFileStatus(workspaceId, { fileId, status, errorReason });
}

async function processJob(job: Job<IndexJobData>): Promise<void> {
  const { fileId } = job.data;
  const { rows } = await query<FileJobRow>(
    `SELECT f.id, f.workspace_id, f.name, f.type, f.disk_path, f.batch_id, f.content_hash,
            fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.id = $1`,
    [fileId],
  );
  const file = rows[0];
  if (!file) return; // File deleted before indexing ran.

  await setStatus(file.id, file.workspace_id, 'indexing');
  // Fresh run: no extraction verdict yet (a stale 'ok' from a previous run must
  // not survive if this run's extraction fails). Batch reconcile waits on NULL.
  await query('UPDATE files SET extraction_status = NULL WHERE id = $1', [file.id]);

  try {
    const buf = await readStoredFile(file.disk_path);

    // Ingest-time Markdown: Claude vision transcribes PDFs/scans/photos in page
    // windows (tables → Markdown tables, real page numbers); docx/xlsx/csv are
    // converted locally; legacy .doc goes through LibreOffice. Stored once and
    // read by read_file, extraction, classification and full-text search — there
    // is no embedding vendor in the pipeline any more.
    // Identical bytes were already converted (re-upload, another shipment, a new
    // version of the same file, a retry) → reuse that Markdown instead of paying
    // for Claude vision again. Only clean conversions are reused.
    const conv = (await reuseMarkdownByHash(file)) ?? (await convertToMarkdown(buf, file.type, file.name));
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
      // Set once the extraction verdict is stored — a later failure (risk scan,
      // classification…) must not be reported as an extraction failure.
      let extractionStored = false;
      try {
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
          await upsertExtraction(file.id, file.workspace_id, fields);
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
          await upsertExtraction(file.id, file.workspace_id, placeholder);
          await query('UPDATE files SET extraction_status = $2 WHERE id = $1', [file.id, 'unreadable']);
        } else {
          // Nothing extractable this run — drop any stale row from a previous run.
          await query('DELETE FROM document_extractions WHERE file_id = $1', [file.id]);
          await query('UPDATE files SET extraction_status = $2 WHERE id = $1', [file.id, 'no_fields']);
        }
        extractionStored = true;
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
          // Single uploads only — a batch gets ONE risk scan in its auto-reconcile
          // (maybeReconcileBatch) instead of a full-workspace rescan per file.
          if (ws.responsible_user_id && !file.batch_id) {
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
        console.error(
          `${extractionStored ? 'Post-extraction step' : 'Extraction'} failed for file ${file.id}:`,
          (err as Error).message,
        );
        // Surface + let the sweep retry it, instead of a silently missing document.
        if (!extractionStored) {
          await query(`UPDATE files SET extraction_status = 'failed' WHERE id = $1`, [file.id]).catch(
            () => undefined,
          );
        }
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
    // Only the LAST attempt is a real 'error' (the retry sweep re-queues errors —
    // doing it while BullMQ still retries ran two jobs for one file).
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (finalAttempt) await setStatus(file.id, file.workspace_id, 'error', reason);
    else {
      await query(`UPDATE files SET status = 'queued', status_changed_at = now() WHERE id = $1`, [file.id]);
      await publishFileStatus(file.workspace_id, { fileId: file.id, status: 'queued' });
    }
    throw err; // Let BullMQ record the failure / retry.
  }
}

async function reuseMarkdownByHash(file: FileJobRow): Promise<ConversionResult | null> {
  if (!file.content_hash) return null;
  const { rows } = await query<{
    pages: ConversionResult['pages'];
    converter: ConversionResult['converter'];
    page_count: number | null;
  }>(
    `SELECT m.pages, m.converter, m.page_count
     FROM files f JOIN file_markdown m ON m.file_id = f.id
     WHERE f.content_hash = $1 AND f.id <> $2 AND m.partial = false
       AND m.converter <> 'none' AND m.char_count > 0
     ORDER BY m.created_at DESC LIMIT 1`,
    [file.content_hash, file.id],
  );
  const r = rows[0];
  if (!r) return null;
  // eslint-disable-next-line no-console
  console.log(`Reusing Markdown for ${file.id} (${file.name}) from an identical file (content hash).`);
  return { pages: r.pages, converter: r.converter, partial: false, pageCount: r.page_count, note: null };
}

/** One extraction row per file (UNIQUE file_id) — replace atomically. */
async function upsertExtraction(fileId: string, workspaceId: string, fields: unknown): Promise<void> {
  await query(
    `INSERT INTO document_extractions (file_id, workspace_id, extracted_fields, model_version)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (file_id) DO UPDATE SET
       extracted_fields = EXCLUDED.extracted_fields, model_version = EXCLUDED.model_version,
       extracted_at = now()`,
    [fileId, workspaceId, JSON.stringify(fields), MODEL],
  );
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
  // Logistics hub: read port / crossing / carrier status out of the fresh news.
  if (config.TRACKING_ENABLED) {
    const s = await scanNewsForHubStatus().catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error('Hub-status news scan failed:', err.message);
      return { scanned: 0, marks: 0 };
    });
    if (s.marks > 0) {
      // eslint-disable-next-line no-console
      console.log(`Hub status: ${s.marks} mark(s) from ${s.scanned} news item(s).`);
    }
  }
}

/**
 * Logistics hub: re-check every active tracked number through the hybrid source
 * chain (official API → carrier page). Per-item failures are recorded on the
 * item; the job always completes.
 */
async function processTracking(_job: Job<TrackingJobData>): Promise<void> {
  const { checked, failed } = await refreshDue();
  if (checked > 0) {
    // eslint-disable-next-line no-console
    console.log(`Hub tracking: re-checked ${checked} item(s) (${failed} failed).`);
  }
}

/**
 * Team Google Sheet → sheet_rows (calendar) + team items in the hub + arrival
 * notifications. Tab failures are recorded per tab; the job always completes.
 */
async function processSheetSync(_job: Job<SheetJobData>): Promise<void> {
  const r = await syncSheet();
  const tabs = Object.entries(r.tabs)
    .map(([t, v]) => `${t}=${v.ok ? v.rows : `error(${v.error})`}`)
    .join(', ');
  // eslint-disable-next-line no-console
  console.log(`Sheet sync: ${tabs}; hub items ${r.hubLinked}, notifications ${r.notified}.`);
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
  await seedPlaces().catch(() => undefined);

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
    // A job that stalled out (worker OOM/SIGKILL) never ran processJob's catch —
    // on the final attempt make sure the file doesn't stay 'indexing' forever.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const reason = err.message?.slice(0, 300) ?? 'failed';
      void query(
        `UPDATE files SET status = 'error', error_reason = $2, status_changed_at = now()
         WHERE id = $1 AND status IN ('queued', 'indexing')
         RETURNING workspace_id`,
        [job.data.fileId, reason],
      )
        .then(({ rows }) => {
          const ws = (rows[0] as { workspace_id?: string } | undefined)?.workspace_id;
          if (ws) return publishFileStatus(ws, { fileId: job.data.fileId, status: 'error', errorReason: reason });
        })
        .catch(() => undefined);
    }
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

  // Logistics hub tracking refresh + live AIS feed. Gated by TRACKING_ENABLED.
  let trackingWorker: Worker<TrackingJobData> | null = null;
  if (config.TRACKING_ENABLED) {
    await scheduleTracking();
    trackingWorker = new Worker<TrackingJobData>(TRACKING_QUEUE, processTracking, {
      connection: createRedis(),
    });
    trackingWorker.on('failed', (job, err) => {
      // eslint-disable-next-line no-console
      console.error(`Tracking job ${job?.id} failed:`, err.message);
    });
    await startAis().catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error('AIS stream failed to start:', err.message);
    });
  }

  // Team Google Sheet sync (hourly). Gated by SHEET_ID.
  let sheetWorker: Worker<SheetJobData> | null = null;
  if (sheetEnabled()) {
    await scheduleSheetSync();
    sheetWorker = new Worker<SheetJobData>(SHEET_QUEUE, processSheetSync, { connection: createRedis() });
    sheetWorker.on('failed', (job, err) => {
      // eslint-disable-next-line no-console
      console.error(`Sheet sync job ${job?.id} failed:`, err.message);
    });
    // First sync right away so a fresh deploy doesn't wait up to an hour.
    void syncSheet().catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error('Initial sheet sync failed:', err.message);
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
      `ingestRetry=${config.INGEST_RETRY_ENABLED}, tracking=${config.TRACKING_ENABLED}, ais=${aisEnabled()}, ` +
      `sheet=${sheetEnabled()}).`,
  );

  const shutdown = async (): Promise<void> => {
    await worker.close();
    if (remindersWorker) await remindersWorker.close();
    if (newsWorker) await newsWorker.close();
    if (trackingWorker) await trackingWorker.close();
    if (sheetWorker) await sheetWorker.close();
    await stopAis();
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
