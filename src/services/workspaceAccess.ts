import { query } from '../db/pool.js';

/** Workspace status: original set plus the derived customs-pipeline stages. */
export type WorkspaceStatus =
  | 'active'
  | 'draft'
  | 'done'
  | 'docs_in_progress'
  | 'docs_complete'
  | 'customs_ready';

export const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = [
  'active',
  'draft',
  'done',
  'docs_in_progress',
  'docs_complete',
  'customs_ready',
] as const;

export interface WorkspaceRow {
  id: string;
  owner_id: string;
  number: string;
  supplier: string;
  status: WorkspaceStatus;
  created_at: string;
  // Phase-1 intake / contract columns (nullable until intake is filled in).
  contract_type: 'bilateral' | 'trilateral' | null;
  intake_complete: boolean;
  product_category: string | null;
  incoterm: string | null;
  transport_mode: string | null;
  origin_country: string | null;
  responsible_user_id: string | null;
}

/**
 * Loads a workspace only if it belongs to the given user. Returns null when the
 * workspace does not exist or is owned by someone else (callers should 404 in
 * both cases — never leak existence of another user's workspace).
 */
export async function getOwnedWorkspace(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRow | null> {
  const { rows } = await query<WorkspaceRow>(
    'SELECT * FROM workspaces WHERE id = $1 AND owner_id = $2',
    [workspaceId, userId],
  );
  return rows[0] ?? null;
}

/**
 * Loads a workspace by id WITHOUT an ownership check. For internal/background use
 * only (worker extraction, reminder job) — never expose directly to a request.
 */
export async function getWorkspaceById(workspaceId: string): Promise<WorkspaceRow | null> {
  const { rows } = await query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [
    workspaceId,
  ]);
  return rows[0] ?? null;
}
