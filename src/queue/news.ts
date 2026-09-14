import { Queue } from 'bullmq';
import { createRedis } from './connection.js';
import { config } from '../config.js';

export const NEWS_QUEUE = 'news';

export interface NewsJobData {
  tick: string;
}

export const newsQueue = new Queue<NewsJobData>(NEWS_QUEUE, {
  connection: createRedis(),
});

/**
 * Ensures exactly one repeatable news-ingest job is scheduled. Removes any
 * existing 'ingest' repeatable first so a changed NEWS_CRON doesn't leave a
 * stale schedule behind. Idempotent — safe to call on every worker boot.
 */
export async function scheduleNews(): Promise<void> {
  const existing = await newsQueue.getRepeatableJobs();
  for (const r of existing) {
    if (r.name === 'ingest') await newsQueue.removeRepeatableByKey(r.key);
  }
  await newsQueue.add(
    'ingest',
    { tick: 'ingest' },
    { repeat: { pattern: config.NEWS_CRON }, removeOnComplete: true, removeOnFail: 50 },
  );
}
