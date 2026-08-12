/* eslint-disable no-console */
import type { PoolClient } from 'pg';
import { pool } from './pool.js';

/**
 * One-time data migration: converts existing workspaces from the old 10-folder
 * customs skeleton to the new 8-folder one (see domain/folders.ts). This is NOT
 * auto-run on boot — invoke it explicitly:
 *
 *   npm run migrate:folders            # dry-run: prints the plan, writes nothing
 *   npm run migrate:folders -- --apply # executes the moves
 *
 * Idempotent: re-running is a no-op once a workspace is on the new skeleton.
 * Folders that aren't part of the skeleton, and inbox files (folder_id IS NULL),
 * are left untouched.
 *
 * Mapping (old → new):
 *   01_Contract + 03_Invoice + 04_Packing_List → 01_Contract_Invoice_PackingList
 *   02_PO                                       → 02_PO                    (pos 1)
 *   05_Certificate                              → 03_Certificate_of_Origin (pos 2)
 *   06_Quality_Certificates                     → 04_Quality_Certificates  (pos 3)
 *   07_Customs                                  → 05_Customs               (pos 4)
 *   08_Transport                                → 06_Transport             (pos 5)
 *   09_Photos                                   → 07_Photos                (pos 6)
 *   10_Final                                    → 08_Final                 (pos 7)
 */

const MERGED_NAME = '01_Contract_Invoice_PackingList';
const MERGE_SOURCES = ['01_Contract', '03_Invoice', '04_Packing_List'] as const;

const RENAMES: { old: string; name: string; position: number }[] = [
  { old: '02_PO', name: '02_PO', position: 1 },
  { old: '05_Certificate', name: '03_Certificate_of_Origin', position: 2 },
  { old: '06_Quality_Certificates', name: '04_Quality_Certificates', position: 3 },
  { old: '07_Customs', name: '05_Customs', position: 4 },
  { old: '08_Transport', name: '06_Transport', position: 5 },
  { old: '09_Photos', name: '07_Photos', position: 6 },
  { old: '10_Final', name: '08_Final', position: 7 },
];

// Old-form names that signal a workspace still needs migrating. 02_PO exists in
// both the old and new skeleton, so it's deliberately excluded from the guard.
const OLD_ONLY = [
  '01_Contract', '03_Invoice', '04_Packing_List', '05_Certificate',
  '06_Quality_Certificates', '07_Customs', '08_Transport', '09_Photos', '10_Final',
];

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

  // Idempotency guard: nothing old-form present → already migrated.
  if (!OLD_ONLY.some((n) => byName.has(n))) {
    return { migrated: false, filesMoved: 0, actions: [] };
  }

  const actions: string[] = [];
  let filesMoved = 0;

  // 1. Determine / ensure the merged folder (id known only after apply for the
  //    create case, but dry-run only needs the human-readable plan).
  let mergedId: string | null = null;
  const existingMerged = byName.get(MERGED_NAME);
  const oldContract = byName.get('01_Contract');
  if (existingMerged) {
    mergedId = existingMerged.id;
    if (existingMerged.position !== 0) actions.push(`set '${MERGED_NAME}' → pos 0`);
  } else if (oldContract) {
    mergedId = oldContract.id;
    actions.push(`rename '01_Contract' → '${MERGED_NAME}' (pos 0)`);
  } else {
    actions.push(`create '${MERGED_NAME}' (pos 0)`);
  }
  if (apply) {
    if (mergedId === null) {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO folders (workspace_id, name, position) VALUES ($1, $2, 0) RETURNING id',
        [ws.id, MERGED_NAME],
      );
      mergedId = rows[0]!.id;
    } else {
      await client.query('UPDATE folders SET name = $2, position = 0 WHERE id = $1', [
        mergedId,
        MERGED_NAME,
      ]);
    }
  }

  // 2. Fold the other merge-source folders into merged, then delete them.
  for (const src of MERGE_SOURCES) {
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

  // 3. Rename / renumber the remaining skeleton folders.
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
    `Folder-skeleton migration — ${mode}` +
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
  console.error('Folder migration failed', err);
  process.exit(1);
});
