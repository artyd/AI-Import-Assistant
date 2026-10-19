import { Queue } from 'bullmq';
import { createRedis } from './connection.js';
import { config } from '../config.js';

export const TRACKING_QUEUE = 'tracking';

export interface TrackingJobData {
  tick: string;
}

export const trackingQueue = new Queue<TrackingJobData>(TRACKING_QUEUE, {
  connection: createRedis(),
});

/**
 * Ensures exactly one repeatable hub-tracking refresh job (TRACKING_CRON).
 * Idempotent — removes a stale schedule first, safe on every worker boot.
 */
export async function scheduleTracking(): Promise<void> {
  const existing = await trackingQueue.getRepeatableJobs();
  for (const r of existing) {
    if (r.name === 'refresh') await trackingQueue.removeRepeatableByKey(r.key);
  }
  await trackingQueue.add(
    'refresh',
    { tick: 'refresh' },
    { repeat: { pattern: config.TRACKING_CRON }, removeOnComplete: true, removeOnFail: 50 },
  );
}
