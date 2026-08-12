import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { MODEL } from '../anthropic/client.js';
import { createRedis } from '../queue/connection.js';
import { INDEX_QUEUE, type IndexJobData } from '../queue/index.js';
import { REMINDERS_QUEUE, scheduleReminders, type ReminderJobData } from '../queue/reminders.js';
import { readStoredFile } from '../services/storage.js';
import { extractText } from '../services/extract/index.js';
import { chunkPages } from '../services/extract/chunk.js';
import { extractDocumentFields } from '../services/extraction/extractFields.js';
import { getWorkspaceById } from '../services/workspaceAccess.js';
import { refreshWorkspaceState } from '../services/status.js';
import { scanAndNotify } from '../services/reminders.js';
import { getEmbeddingProvider } from '../services/embeddings/index.js';
import {
  ensureQdrantCollection,
  deleteFileChunks,
  upsertChunks,
  type ChunkPayload,
} from '../services/qdrant.js';
import { publishFileStatus } from '../events/fileStatus.js';
import type { FileType } from '../domain/folders.js';

interface FileJobRow {
  id: string;
  workspace_id: string;
  name: string;
  type: FileType;
  disk_path: string;
  folder_name: string | null;
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
    `SELECT f.id, f.workspace_id, f.name, f.type, f.disk_path, fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.id = $1`,
    [fileId],
  );
  const file = rows[0];
  if (!file) return; // File deleted before indexing ran.

  await setStatus(file.id, file.workspace_id, 'indexing');

  try {
    const buf = await readStoredFile(file.disk_path);
    const pages = await extractText(buf, file.type);
    const chunks = chunkPages(pages);

    // Replace any prior vectors for this file (safe on re-index).
    await deleteFileChunks(file.id);

    if (chunks.length > 0) {
      const vectors = await getEmbeddingProvider().embed(
        chunks.map((c) => c.text),
        'document',
      );
      const payloads: ChunkPayload[] = chunks.map((c) => ({
        workspace_id: file.workspace_id,
        file_id: file.id,
        file_name: file.name,
        folder: file.folder_name,
        chunk_index: c.index,
        page: c.page,
        text: c.text,
      }));
      await upsertChunks(vectors, payloads);
    }

    // Files without a text layer (e.g. images) are still "ready" — there is
    // simply nothing to index (OCR is a documented v2 addition).
    await setStatus(file.id, file.workspace_id, 'ready');

    // Structured extraction (best-effort): populate document_extractions so the
    // checklist/discrepancy checks are deterministic. A failure here must NOT
    // fail indexing — the file stays "ready".
    if (config.EXTRACTION_ENABLED && pages.length > 0) {
      try {
        const fullText = pages.map((p) => p.text).join('\n\n');
        await query('DELETE FROM document_extractions WHERE file_id = $1', [file.id]);
        const fields = await extractDocumentFields(fullText);
        if (fields) {
          await query(
            `INSERT INTO document_extractions (file_id, workspace_id, extracted_fields, model_version)
             VALUES ($1, $2, $3::jsonb, $4)`,
            [file.id, file.workspace_id, JSON.stringify(fields), MODEL],
          );
        }
        const ws = await getWorkspaceById(file.workspace_id);
        if (ws) await refreshWorkspaceState(ws);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`Extraction failed for file ${file.id}:`, (err as Error).message);
      }
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

async function main(): Promise<void> {
  await runMigrations();
  await ensureQdrantCollection();

  const worker = new Worker<IndexJobData>(INDEX_QUEUE, processJob, {
    connection: createRedis(),
    concurrency: 3,
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

  // eslint-disable-next-line no-console
  console.log(
    `Indexing worker started (env=${config.NODE_ENV}, extraction=${config.EXTRACTION_ENABLED}, reminders=${config.REMINDERS_ENABLED}).`,
  );

  const shutdown = async (): Promise<void> => {
    await worker.close();
    if (remindersWorker) await remindersWorker.close();
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
