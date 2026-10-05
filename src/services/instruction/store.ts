import { pool, query } from '../../db/pool.js';
import { draftSchema, type InstructionDraft } from './types.js';

export interface InstructionVersion {
  id: string;
  version: number;
  status: 'draft' | 'approved' | 'sent';
  draft: InstructionDraft;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  version: number;
  status: InstructionVersion['status'];
  draft: unknown;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT si.id, si.version, si.status, si.draft, u.name AS created_by_name, si.created_at, si.updated_at
  FROM supplier_instructions si LEFT JOIN users u ON u.id = si.created_by`;

/** Stored drafts are re-parsed so older versions pick up new defaults safely. */
const toVersion = (r: Row): InstructionVersion => ({
  id: r.id,
  version: r.version,
  status: r.status,
  draft: draftSchema.parse(r.draft),
  createdBy: r.created_by_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listVersions(workspaceId: string): Promise<InstructionVersion[]> {
  const { rows } = await query<Row>(`${SELECT} WHERE si.workspace_id = $1 ORDER BY si.version DESC`, [workspaceId]);
  return rows.map(toVersion);
}

export async function getVersion(workspaceId: string, version: number): Promise<InstructionVersion | null> {
  const { rows } = await query<Row>(`${SELECT} WHERE si.workspace_id = $1 AND si.version = $2`, [workspaceId, version]);
  return rows[0] ? toVersion(rows[0]) : null;
}

/** The version that drives the compliance check: latest approved/sent. */
export async function latestApproved(workspaceId: string): Promise<InstructionVersion | null> {
  const { rows } = await query<Row>(
    `${SELECT} WHERE si.workspace_id = $1 AND si.status IN ('approved', 'sent') ORDER BY si.version DESC LIMIT 1`,
    [workspaceId],
  );
  return rows[0] ? toVersion(rows[0]) : null;
}

export async function createVersion(workspaceId: string, draft: InstructionDraft, userId: string | null): Promise<InstructionVersion> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize version numbering per shipment.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('instr:' || $1))", [workspaceId]);
    const { rows } = await client.query<{ v: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM supplier_instructions WHERE workspace_id = $1',
      [workspaceId],
    );
    await client.query(
      `INSERT INTO supplier_instructions (workspace_id, version, draft, created_by) VALUES ($1, $2, $3, $4)`,
      [workspaceId, rows[0]!.v, JSON.stringify(draft), userId],
    );
    await client.query('COMMIT');
    return (await getVersion(workspaceId, rows[0]!.v))!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateVersion(
  workspaceId: string,
  version: number,
  patch: { draft?: InstructionDraft; status?: InstructionVersion['status'] },
): Promise<InstructionVersion | null> {
  const sets: string[] = ['updated_at = now()'];
  const vals: unknown[] = [workspaceId, version];
  if (patch.draft) {
    vals.push(JSON.stringify(patch.draft));
    sets.push(`draft = $${vals.length}`);
  }
  if (patch.status) {
    vals.push(patch.status);
    sets.push(`status = $${vals.length}`);
  }
  await query(`UPDATE supplier_instructions SET ${sets.join(', ')} WHERE workspace_id = $1 AND version = $2`, vals);
  return getVersion(workspaceId, version);
}
