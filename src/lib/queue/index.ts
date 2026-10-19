import { Queue } from 'bullmq';
import { createRedis } from './connection.js';

export const INDEX_QUEUE = 'indexing';

export interface IndexJobData {
  fileId: string;
}

export const indexingQueue = new Queue<IndexJobData>(INDEX_QUEUE, {
  connection: createRedis(),
});

/**
 * Enqueue a background indexing job for a file. Idempotent per file: the job id
 * IS the file id, so upload + reindex + retry sweep + agent re-queue can't run
 * two jobs for one file at once (double Claude spend, duplicate extraction
 * rows). A finished (failed/completed) job with that id is removed first so the
 * file can be re-indexed. Returns false when a live job already exists.
 */
export async function enqueueIndexJob(fileId: string): Promise<boolean> {
  const existing = await indexingQueue.getJob(fileId);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'failed' && state !== 'completed' && state !== 'unknown') return false;
    await existing.remove().catch(() => undefined);
  }
  await indexingQueue.add(
    'index',
    { fileId },
    {
      jobId: fileId,
      removeOnComplete: true,
      removeOnFail: 500,
      // More attempts + a longer exponential backoff so a file whose indexing
      // hit a transient rate-limit / network error (beyond the Anthropic SDK's
      // own in-call retries) is re-tried over minutes rather than given up on
      // after 2 quick tries. 5 attempts ≈ 5s,10s,20s,40s between them.
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );
  return true;
}

/** True when the file has a job that is still waiting/running in the queue. */
export async function hasLiveIndexJob(fileId: string): Promise<boolean> {
  const job = await indexingQueue.getJob(fileId);
  if (!job) return false;
  const state = await job.getState();
  return state !== 'failed' && state !== 'completed' && state !== 'unknown';
}
