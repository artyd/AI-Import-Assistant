import { Queue } from 'bullmq';
import { createRedis } from './connection.js';
import { config } from '../config.js';

export const SHEET_QUEUE = 'sheet-sync';

export interface SheetJobData {
  tick: string;
}

export const sheetQueue = new Queue<SheetJobData>(SHEET_QUEUE, {
  connection: createRedis(),
});

/**
 * Ensures exactly one repeatable sheet-sync job is scheduled. Removes any
 * existing 'sync' repeatable first so a changed SHEET_SYNC_CRON doesn't leave a
 * stale schedule behind. Idempotent — safe to call on every worker boot.
 */
export async function scheduleSheetSync(): Promise<void> {
  const existing = await sheetQueue.getRepeatableJobs();
  for (const r of existing) {
    if (r.name === 'sync') await sheetQueue.removeRepeatableByKey(r.key);
  }
  await sheetQueue.add(
    'sync',
    { tick: 'sync' },
    { repeat: { pattern: config.SHEET_SYNC_CRON }, removeOnComplete: true, removeOnFail: 50 },
  );
}
