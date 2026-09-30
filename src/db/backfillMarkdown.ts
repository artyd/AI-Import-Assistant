/* eslint-disable no-console */
import { pool, query } from './pool.js';
import { enqueueIndexJob, indexingQueue } from '../queue/index.js';
import { publishFileStatus } from '../events/fileStatus.js';

/**
 * One-time backfill for the Claude-only Markdown pipeline: re-queues every current
 * workspace file that has no stored Markdown yet (indexed before the pipeline
 * existed), so the worker converts it (Claude vision for PDFs/scans), fills the
 * full-text search sections and re-runs structured extraction. NOT auto-run:
 *
 *   npm run migrate:markdown            # dry-run: prints how many files, writes nothing
 *   npm run migrate:markdown -- --apply # enqueues them
 *
 * In Docker: docker compose exec worker node dist/db/backfillMarkdown.js --apply
 * Idempotent — files that already have Markdown are skipped. Until a file is
 * backfilled, read_file still converts it lazily on first read.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const { rows } = await query<{ id: string; name: string; workspace_id: string }>(
    `SELECT f.id, f.name, f.workspace_id FROM files f
     WHERE f.is_latest = true AND f.status IN ('ready', 'error')
       AND NOT EXISTS (SELECT 1 FROM file_markdown m WHERE m.file_id = f.id)
     ORDER BY f.created_at`,
  );
  console.log(`${rows.length} file(s) without Markdown.`);
  if (apply) {
    for (const f of rows) {
      await query(`UPDATE files SET status = 'queued', error_reason = NULL WHERE id = $1`, [f.id]);
      await publishFileStatus(f.workspace_id, { fileId: f.id, status: 'queued' });
      await enqueueIndexJob(f.id);
    }
    console.log(`Enqueued ${rows.length} file(s) for conversion.`);
  } else if (rows.length) {
    console.log('Dry run — re-run with --apply to enqueue.');
  }
  await indexingQueue.close();
  await pool.end();
  // The status publisher holds an open Redis connection; exit explicitly.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
