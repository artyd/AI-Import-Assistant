import { Queue } from 'bullmq';
import { createRedis } from './connection.js';
import { config } from '../config.js';

export const INGEST_RETRY_QUEUE = 'ingest-retry';

export interface IngestRetryJobData {
  tick: string;
}

export const ingestRetryQueue = new Queue<IngestRetryJobData>(INGEST_RETRY_QUEUE, {
  connection: createRedis(),
});

/**
 * Ensures exactly one repeatable sweep job is scheduled on INGEST_RETRY_CRON.
 * Removes any prior 'sweep' repeatable first so a changed cron doesn't leave a
 * stale schedule. Idempotent — safe on every worker boot.
 */
export async function scheduleIngestRetry(): Promise<void> {
  const existing = await ingestRetryQueue.getRepeatableJobs();
  for (const r of existing) {
    if (r.name === 'sweep') await ingestRetryQueue.removeRepeatableByKey(r.key);
  }
  await ingestRetryQueue.add(
    'sweep',
    { tick: 'sweep' },
    { repeat: { pattern: config.INGEST_RETRY_CRON }, removeOnComplete: true, removeOnFail: 50 },
  );
}
