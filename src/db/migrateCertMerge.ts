/* eslint-disable no-console */
import type { PoolClient } from 'pg';
import { pool } from './pool.js';

/**
 * One-time data migration: merges the two certificate folders into a single
 * `03_Certificates` folder and renumbers the trailing folders so numbering stays
 * contiguous (8 → 7 folders). See domain/folders.ts. NOT auto-run on boot:
 *
 *   npm run migrate:cert-merge            # dry-run: prints the plan, writes nothing
 *   npm run migrate:cert-merge -- --apply # executes the moves
 *
 * Idempotent: re-running is a no-op once a workspace is on the merged skeleton.
 * Inbox files (folder_id IS NULL) and non-skeleton folders are left untouched.
 *
 * Mapping (old → new):
 *   03_Certificate_of_Origin + 04_Quality_Certificates → 03_Certificates (pos 2)
 *   05_Customs   → 04_Customs   (pos 3)
 *   06_Transport → 05_Transport (pos 4)
 *   07_Photos    → 06_Photos    (pos 5)
 *   08_Final     → 07_Final     (pos 6)
 */

const MERGED_NAME = '03_Certificates';
const CERT_SOURCES = ['03_Certificate_of_Origin', '04_Quality_Certificates'] as const;

const RENAMES: { old: string; name: string; position: number }[] = [
  { old: '05_Customs', name: '04_Customs', position: 3 },
  { old: '06_Transport', name: '05_Transport', position: 4 },
  { old: '07_Photos', name: '06_Photos', position: 5 },
  { old: '08_Final', name: '07_Final', position: 6 },
];

// Presence of either old-form certificate folder signals a workspace still needs
// migrating (both only exist pre-merge).
const OLD_ONLY = ['03_Certificate_of_Origin', '04_Quality_Certificates'];

interface WsRow {
  id: string;
  number: string;
}
interface FolderRow {
  id: string;
  name: string;
  position: number;
}

async function countFiles(client: PoolClient, folderId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM files WHERE folder_id = $1',
    [folderId],
  );
  return rows[0]?.n ?? 0;
}

interface WsResult {
  migrated: boolean;
  filesMoved: number;
  actions: string[];
}

async function migrateWorkspace(
  client: PoolClient,
  ws: WsRow,
  apply: boolean,
): Promise<WsResult> {
  const { rows: folders } = await client.query<FolderRow>(
    'SELECT id, name, position FROM folders WHERE workspace_id = $1',
    [ws.id],
  );
  const byName = new Map(folders.map((f) => [f.name, f]));

  // Idempotency guard: no old-form certificate folder present → already merged.
  if (!OLD_ONLY.some((n) => byName.has(n))) {
    return { migrated: false, filesMoved: 0, actions: [] };
  }

  const actions: string[] = [];
  let filesMoved = 0;

  // 1. Determine / ensure the merged folder at position 2. Prefer reusing the
  //    origin-certificate folder; fall back to the quality folder, else create.
  let mergedId: string | null = null;
  const coo = byName.get('03_Certificate_of_Origin');
  const quality = byName.get('04_Quality_Certificates');
  if (coo) {
    mergedId = coo.id;
    actions.push(`rename '03_Certificate_of_Origin' → '${MERGED_NAME}' (pos 2)`);
  } else if (quality) {
    mergedId = quality.id;
    actions.push(`rename '04_Quality_Certificates' → '${MERGED_NAME}' (pos 2)`);
  } else {
    actions.push(`create '${MERGED_NAME}' (pos 2)`);
  }
  if (apply) {
    if (mergedId === null) {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO folders (workspace_id, name, position) VALUES ($1, $2, 2) RETURNING id',
        [ws.id, MERGED_NAME],
      );
      mergedId = rows[0]!.id;
    } else {
      await client.query('UPDATE folders SET name = $2, position = 2 WHERE id = $1', [
        mergedId,
        MERGED_NAME,
      ]);
    }
  }

  // 2. Fold the other certificate folder into merged, then delete it.
  for (const src of CERT_SOURCES) {
    const folder = byName.get(src);
    if (!folder || folder.id === mergedId) continue;
    const n = await countFiles(client, folder.id);
    filesMoved += n;
    actions.push(`move ${n} file(s) '${src}' → '${MERGED_NAME}', delete '${src}'`);
    if (apply) {
      await client.query('UPDATE files SET folder_id = $1 WHERE folder_id = $2', [
        mergedId,
        folder.id,
      ]);
      await client.query('DELETE FROM folders WHERE id = $1', [folder.id]);
    }
  }

  // 3. Renumber the remaining skeleton folders.
  for (const r of RENAMES) {
    const folder = byName.get(r.old);
    if (!folder) continue;
    if (folder.name !== r.name || folder.position !== r.position) {
      actions.push(`rename '${r.old}' → '${r.name}' (pos ${r.position})`);
      if (apply) {
        await client.query('UPDATE folders SET name = $2, position = $3 WHERE id = $1', [
          folder.id,
          r.name,
          r.position,
        ]);
      }
    }
  }

  return { migrated: actions.length > 0, filesMoved, actions };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(
    `Certificate-folder merge migration — ${mode}` +
      (apply ? '' : ' (no changes written; pass --apply to execute)'),
  );

  const { rows: workspaces } = await pool.query<WsRow>(
    'SELECT id, number FROM workspaces ORDER BY created_at',
  );

  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  let totalFiles = 0;

  for (const ws of workspaces) {
    scanned++;
    const client = await pool.connect();
    try {
      if (apply) await client.query('BEGIN');
      const res = await migrateWorkspace(client, ws, apply);
      if (apply) await client.query('COMMIT');
      if (res.migrated) {
        migrated++;
        totalFiles += res.filesMoved;
        console.log(`\nWorkspace ${ws.number} (${ws.id}):`);
        for (const a of res.actions) console.log(`  - ${a}`);
      } else {
        skipped++;
      }
    } catch (err) {
      if (apply) await client.query('ROLLBACK');
      console.error(`Workspace ${ws.number} (${ws.id}) FAILED:`, (err as Error).message);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(
    `\nSummary (${mode}): scanned ${scanned}, ` +
      `${apply ? 'migrated' : 'to migrate'} ${migrated}, skipped ${skipped}, ` +
      `files ${apply ? 'moved' : 'to move'} ${totalFiles}.`,
  );

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Certificate merge migration failed', err);
  process.exit(1);
});
