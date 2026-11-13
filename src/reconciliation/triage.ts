import { query } from '../db/pool.js';
import type { TriageReason, TriageRow, TriageStatus } from './fingerprint.js';

/**
 * Store of the user's decisions on findings (`finding_triage`, spec 011). Plain
 * Postgres I/O; the fingerprints and the decoration of verdicts are pure and
 * live in `fingerprint.ts`. A writer here must be followed by
 * `shipmentChanged(id, { kind: 'triage' })` (the routes do it).
 */

interface DbRow {
  fingerprint: string;
  status: TriageStatus;
  reason: TriageReason | null;
  note: string;
  title: string;
  lot: string | null;
  user_name: string | null;
  decided_at: Date | string;
}

function toRow(r: DbRow): TriageRow {
  return {
    fingerprint: r.fingerprint,
    status: r.status,
    reason: r.reason,
    note: r.note,
    title: r.title,
    lot: r.lot,
    user_name: r.user_name ?? '',
    decided_at: r.decided_at instanceof Date ? r.decided_at.toISOString() : String(r.decided_at),
  };
}

const SELECT = `SELECT t.fingerprint, t.status, t.reason, t.note, t.title, t.lot, t.decided_at,
                       COALESCE(NULLIF(u.name, ''), u.email, '') AS user_name
                FROM finding_triage t LEFT JOIN users u ON u.id = t.user_id`;

/** Every decision of a shipment / FCL, oldest first. */
export async function loadTriage(workspaceId: string): Promise<TriageRow[]> {
  const { rows } = await query<DbRow>(`${SELECT} WHERE t.workspace_id = $1 ORDER BY t.decided_at, t.fingerprint`, [workspaceId]);
  return rows.map(toRow);
}

export interface TriageInput {
  status: TriageStatus;
  reason: TriageReason | null;
  note: string;
  title: string;
  lot: string | null;
}

/** Records (or replaces) the decision on a finding; returns it with the user's name. */
export async function upsertTriage(workspaceId: string, userId: string, fingerprint: string, input: TriageInput): Promise<TriageRow> {
  await query(
    `INSERT INTO finding_triage (workspace_id, fingerprint, status, reason, note, title, lot, user_id, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (workspace_id, fingerprint) DO UPDATE
       SET status = EXCLUDED.status, reason = EXCLUDED.reason, note = EXCLUDED.note,
           title = EXCLUDED.title, lot = EXCLUDED.lot, user_id = EXCLUDED.user_id, decided_at = now()`,
    [workspaceId, fingerprint, input.status, input.status === 'not_problem' ? input.reason : null, input.note, input.title, input.lot, userId],
  );
  const { rows } = await query<DbRow>(`${SELECT} WHERE t.workspace_id = $1 AND t.fingerprint = $2`, [workspaceId, fingerprint]);
  return toRow(rows[0]!);
}

/** «Повернути»: removes the decision. True when there was one. */
export async function deleteTriage(workspaceId: string, fingerprint: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM finding_triage WHERE workspace_id = $1 AND fingerprint = $2', [workspaceId, fingerprint]);
  return (rowCount ?? 0) > 0;
}
