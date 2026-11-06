import { pool, query } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { publishFileStatus } from '../lib/events/fileStatus.js';
import { enqueueIndexJob, indexingQueue } from '../lib/queue/index.js';

/**
 * Re-read spreadsheets (xlsx/csv) whose Markdown came from the old converter
 * ('sheet': first row = header, no row numbers, merged headers lost) so they get
 * the 'sheet2' layout. Dry run unless --apply. Files whose fields a human
 * confirmed on the verification screen are skipped — a re-read would overwrite
 * those corrections. Run in the container:
 *   node dist/ingest/reindexSheets.js            # what would be re-read
 *   node dist/ingest/reindexSheets.js --apply    # queue them for the worker
 */
export async function reindexSheets(apply: boolean): Promise<{ queued: number; skippedVerified: number }> {
  const { rows } = await query<{ id: string; name: string; workspace_id: string; number: string; verified: boolean }>(
    `SELECT f.id, f.name, f.workspace_id, w.number,
            COALESCE((de.extracted_fields->>'verified')::boolean, false) AS verified
     FROM files f
     JOIN workspaces w ON w.id = f.workspace_id
     JOIN file_markdown m ON m.file_id = f.id
     LEFT JOIN document_extractions de ON de.file_id = f.id
     WHERE f.type IN ('xlsx', 'csv') AND m.converter = 'sheet' AND f.is_latest = true
     ORDER BY w.number, f.name`,
  );
  const todo = rows.filter((r) => !r.verified);
  /* eslint-disable no-console */
  for (const r of rows) console.log(`${r.verified ? '= пропуск (поля підтверджено вручну)' : '+'} ${r.number}: ${r.name}`);
  console.log(`Таблиць зі старою розміткою: ${rows.length}; до перечитування: ${todo.length}; пропущено: ${rows.length - todo.length}.`);
  /* eslint-enable no-console */
  if (apply) {
    for (const r of todo) {
      await query(
        `UPDATE files SET status = 'queued', error_reason = NULL, index_attempts = 0, status_changed_at = now() WHERE id = $1`,
        [r.id],
      );
      await enqueueIndexJob(r.id);
      await publishFileStatus(r.workspace_id, { fileId: r.id, status: 'queued', name: r.name });
    }
  }
  return { queued: apply ? todo.length : 0, skippedVerified: rows.length - todo.length };
}

if (process.argv[1]?.endsWith('reindexSheets.js')) {
  const apply = process.argv.includes('--apply');
  runMigrations()
    .then(() => reindexSheets(apply))
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(apply ? `У черзі: ${r.queued}. Воркер перечитає їх за кілька хвилин.` : 'Це перевірка — нічого не змінено. Щоб перечитати, додайте --apply.');
    })
    .then(() => indexingQueue.close())
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error('Reindex failed:', err.message);
      process.exit(1);
    });
}
