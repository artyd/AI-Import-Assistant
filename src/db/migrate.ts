import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

/**
 * Applies schema.sql idempotently. Safe to run on every boot — all statements
 * use IF NOT EXISTS. Run standalone via `npm run migrate`, or import
 * runMigrations() from the server bootstrap.
 */
export async function runMigrations(): Promise<void> {
  const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
  const ddl = readFileSync(schemaPath, 'utf8');
  await pool.query(ddl);
}

// Allow `node dist/db/migrate.js` as a one-shot.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('Migrations applied.');
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Migration failed', err);
      process.exit(1);
    });
}
