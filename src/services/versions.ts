import { query } from '../db/pool.js';

/**
 * Structured field diff between two files' latest extractions — the deterministic
 * backing for "compare drafts / versions". Shared by POST /compare-versions and
 * the agent's compare_document_versions tool.
 */

export interface FieldDiff {
  field: string;
  a: unknown;
  b: unknown;
}

async function latestExtraction(fileId: string): Promise<Record<string, unknown>> {
  const { rows } = await query<{ extracted_fields: Record<string, unknown> }>(
    `SELECT extracted_fields FROM document_extractions
     WHERE file_id = $1 ORDER BY extracted_at DESC LIMIT 1`,
    [fileId],
  );
  return rows[0]?.extracted_fields ?? {};
}

/** Returns null if either file doesn't belong to the workspace. */
export async function compareFileVersions(
  workspaceId: string,
  fileIdA: string,
  fileIdB: string,
): Promise<{ differences: FieldDiff[] } | null> {
  const { rows: owned } = await query<{ id: string }>(
    'SELECT id FROM files WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
    [workspaceId, [fileIdA, fileIdB]],
  );
  const ids = new Set(owned.map((r) => r.id));
  if (!ids.has(fileIdA) || !ids.has(fileIdB)) return null;

  const a = await latestExtraction(fileIdA);
  const b = await latestExtraction(fileIdB);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const differences = keys
    .map((field) => ({ field, a: a[field] ?? null, b: b[field] ?? null }))
    .filter((d) => JSON.stringify(d.a) !== JSON.stringify(d.b));

  return { differences };
}

/** The file this one supersedes (its previous version), scoped to the workspace. */
export async function previousVersionId(
  workspaceId: string,
  fileId: string,
): Promise<string | null> {
  const { rows } = await query<{ replaces_file_id: string | null }>(
    'SELECT replaces_file_id FROM files WHERE id = $1 AND workspace_id = $2',
    [fileId, workspaceId],
  );
  return rows[0]?.replaces_file_id ?? null;
}
