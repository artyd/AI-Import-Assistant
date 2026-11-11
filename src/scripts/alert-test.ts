/* eslint-disable no-console */
import { pool } from '../db/pool.js';
import { notifyOpsAsync } from '../lib/alerts.js';

/**
 * Sends one test ops_alert to the bell of the configured recipients and prints
 * how many got it. Usage: `npm run alert:test` (in a container:
 * `docker compose exec backend node dist/scripts/alert-test.js`).
 */
async function main(): Promise<void> {
  const n = await notifyOpsAsync({
    source: 'backend',
    severity: 'info',
    title: 'тестове сповіщення',
    detail: 'alert:test',
    key: 'alert-test',
    force: true,
  });
  console.log(`Test ops alert delivered to ${n} recipient(s).`);
  await pool.end();
  process.exit(n > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('alert-test failed', err);
  process.exit(1);
});
