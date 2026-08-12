import { Queue } from 'bullmq';
import { createRedis } from './connection.js';
import { config } from '../config.js';

export const REMINDERS_QUEUE = 'reminders';

export interface ReminderJobData {
  tick: string;
}

export const remindersQueue = new Queue<ReminderJobData>(REMINDERS_QUEUE, {
  connection: createRedis(),
});

/**
 * Ensures exactly one daily repeatable reminder job is scheduled. Removes any
 * existing 'daily' repeatable first so a changed REMINDERS_CRON doesn't leave a
 * stale schedule behind. Idempotent — safe to call on every worker boot.
 */
export async function scheduleReminders(): Promise<void> {
  const existing = await remindersQueue.getRepeatableJobs();
  for (const r of existing) {
    if (r.name === 'daily') await remindersQueue.removeRepeatableByKey(r.key);
  }
  await remindersQueue.add(
    'daily',
    { tick: 'daily' },
    { repeat: { pattern: config.REMINDERS_CRON }, removeOnComplete: true, removeOnFail: 50 },
  );
}
