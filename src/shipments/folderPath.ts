import { query } from '../db/pool.js';

/** Folder names from the root down, for one folder ("Митниця / Shandong X"). */
export async function folderPath(folderId: string): Promise<string[]> {
  const { rows } = await query<{ name: string }>(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, name, 0 AS depth FROM folders WHERE id = $1
       UNION ALL
       SELECT f.id, f.parent_id, f.name, up.depth + 1 FROM folders f JOIN up ON f.id = up.parent_id
       WHERE up.depth < 10
     )
     SELECT name FROM up ORDER BY depth DESC`,
    [folderId],
  );
  return rows.map((r) => r.name);
}

/** Every folder of a workspace with its full path (for the disk mirror and ZIP export). */
export async function folderPaths(workspaceId: string): Promise<Map<string, string[]>> {
  const { rows } = await query<{ id: string; parent_id: string | null; name: string }>(
    'SELECT id, parent_id, name FROM folders WHERE workspace_id = $1',
    [workspaceId],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const path: string[] = [];
    let cur: typeof r | undefined = r;
    for (let i = 0; cur && i < 10; i++) {
      path.unshift(cur.name);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    out.set(r.id, path);
  }
  return out;
}
