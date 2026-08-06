import pg from 'pg';
import { config } from '../config.js';

/**
 * Shared PostgreSQL connection pool. Import { pool, query } wherever DB access
 * is needed; do not construct additional pools.
 */
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected PostgreSQL pool error', err);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}
