import { config } from '../config.js';
import { query } from '../db/pool.js';
import { enqueueIndexJob, hasLiveIndexJob } from '../queue/index.js';
import { publishFileStatus } from '../events/fileStatus.js';
import { maybeReconcileBatch } from './reconcileBatch.js';

interface StuckFileRow {
  id: string;
  workspace_id: string;
  name: string;
  index_attempts: number;
  batch_id: string | null;
}

export interface SweepResult {
  requeued: number;
  flagged: number;
}

// A file in queued/indexing longer than this with NO live queue job is stuck
// (worker crash, stalled job, enqueue failure after the row was inserted).
const STUCK_AFTER_MINUTES = 30;

/**
 * Auto-retry sweep for files that exhausted their BullMQ job attempts and are
 * sitting in status='error'. The BullMQ `attempts` handle transient failures
 * within a single indexing run (seconds); THIS handles the longer tail —
 * re-queuing a failed file every few minutes so a prolonged rate-limit or a
 * temporarily-down dependency still gets read once things recover.
 *
 * Escalation, so nothing is ever silently lost (the user's #1 requirement):
 *  - index_attempts <  INGEST_MAX_RETRIES → reset to 'queued', bump the counter,
 *    re-enqueue an index job.
 *  - index_attempts >= INGEST_MAX_RETRIES → stop retrying and FLAG it
 *    (extraction_status='unreadable') so it surfaces on the problem-files /
 *    verification screen for manual key-field entry. Stays status='error' with a
 *    clear reason so it's visibly "needs a human", not "in progress".
 *
 * Returns how many files were re-queued vs newly flagged.
 */
export async function sweepStuckFiles(): Promise<SweepResult> {
  // Retry candidates: indexing errors, files whose structured extraction call
  // failed (status ready but extraction_status 'failed'), and files stuck in
  // queued/indexing with no live job behind them.
  const { rows: candidates } = await query<StuckFileRow & { status: string }>(
    `SELECT f.id, f.workspace_id, f.name, f.index_attempts, f.batch_id, f.status
     FROM files f
     WHERE (f.status = 'error' AND f.extraction_status IS DISTINCT FROM 'unreadable')
        OR (f.status = 'ready' AND f.extraction_status = 'failed')
        OR (f.status IN ('queued', 'indexing')
            AND COALESCE(f.status_changed_at, f.created_at) < now() - interval '${STUCK_AFTER_MINUTES} minutes')`,
  );
  const rows: StuckFileRow[] = [];
  for (const f of candidates) {
    if ((f.status === 'queued' || f.status === 'indexing') && (await hasLiveIndexJob(f.id))) continue;
    rows.push(f);
  }

  let requeued = 0;
  let flagged = 0;
  // Batches that just had a file flagged — their last blocker may be cleared, so
  // re-check auto-reconcile after the sweep.
  const touchedBatches = new Set<string>();

  for (const f of rows) {
    if (f.index_attempts < config.INGEST_MAX_RETRIES) {
      await query(
        `UPDATE files
         SET status = 'queued', error_reason = NULL, index_attempts = index_attempts + 1,
             status_changed_at = now()
         WHERE id = $1`,
        [f.id],
      );
      await enqueueIndexJob(f.id);
      await publishFileStatus(f.workspace_id, { fileId: f.id, status: 'queued', name: f.name });
      requeued += 1;
    } else {
      // Give up auto-reading; flag for a human. Keep status='error' so it reads
      // as "failed — needs manual entry", distinct from the worker's own
      // status='ready'+unreadable path (a scan it read as an image but got no
      // text from). error_reason tells the user what to do.
      await query(
        `UPDATE files
         SET status = 'error', extraction_status = 'unreadable',
             error_reason = $2, status_changed_at = now()
         WHERE id = $1`,
        [
          f.id,
          `Не вдалося прочитати після ${config.INGEST_MAX_RETRIES} спроб — введіть ключові поля вручну.`,
        ],
      );
      await publishFileStatus(f.workspace_id, {
        fileId: f.id,
        status: 'error',
        errorReason: 'needs_manual_entry',
      });
      flagged += 1;
      if (f.batch_id) touchedBatches.add(f.batch_id);
    }
  }

  // Flagging a persistently-unreadable file can complete its batch (that file is
  // now terminal, not retriable) — fire the deterministic auto-reconcile.
  for (const batchId of touchedBatches) {
    try {
      await maybeReconcileBatch(batchId);
    } catch {
      // Best-effort; the batch stays unreconciled and can be retried next sweep.
    }
  }

  return { requeued, flagged };
}
