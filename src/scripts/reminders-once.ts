/* eslint-disable no-console */
import { pool } from '../db/pool.js';
import { scanAndNotify } from '../services/reminders.js';

/**
 * Runs the reminder scan once and exits — for verifying reminders without waiting
 * for the daily cron. Usage: `npm run reminders:once`.
 */
async function main(): Promise<void> {
  const n = await scanAndNotify();
  console.log(`Reminder scan complete: ${n} notification(s) inserted.`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('reminders-once failed', err);
  process.exit(1);
});
