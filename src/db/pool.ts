import pg from 'pg';
import { config } from '../lib/config.js';
import { instrumentQuery, logSlowQuery } from './slowQuery.js';

/**
 * Shared PostgreSQL connection pool. Import { pool, query } wherever DB access
 * is needed; do not construct additional pools.
 */
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected PostgreSQL pool error', err);
});

// Slow-query log (SLOW_QUERY_MS, default 500; 0 disables). Every pooled client —
// including the ones behind pool.query() and explicit pool.connect() transactions —
// is instrumented once when created. Logs duration + first 200 chars of SQL only,
// never parameters.
pool.on('connect', (client) => instrumentQuery(client as unknown as { query: never }, config.SLOW_QUERY_MS, logSlowQuery));

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}
