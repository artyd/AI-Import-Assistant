import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

// Arbitrary constant key for pg_advisory_lock — one migration at a time.
const MIGRATION_LOCK_KEY = 815_004_2026;

/**
 * Applies schema.sql idempotently (all statements are IF NOT EXISTS / guarded).
 *
 * Server and worker both call this on boot. It runs under a Postgres advisory
 * lock (they used to race: concurrent CREATE TABLE could fail one process on a
 * fresh DB), and is SKIPPED when schema.sql is unchanged since the last apply
 * (tracked by content hash) — re-running it every boot took ACCESS EXCLUSIVE
 * locks (constraint drop/add) on hot tables while live queries waited.
 */
export async function runMigrations(): Promise<void> {
  const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
  const ddl = readFileSync(schemaPath, 'utf8');
  const hash = createHash('sha256').update(ddl).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_meta (
         id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
         schema_hash TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ schema_hash: string }>('SELECT schema_hash FROM schema_meta WHERE id = 1');
    if (rows[0]?.schema_hash === hash) return;
    await client.query(ddl);
    await client.query(
      `INSERT INTO schema_meta (id, schema_hash) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET schema_hash = EXCLUDED.schema_hash, applied_at = now()`,
      [hash],
    );
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
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
