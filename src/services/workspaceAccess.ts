import { query } from '../db/pool.js';

export interface WorkspaceRow {
  id: string;
  owner_id: string;
  number: string;
  supplier: string;
  status: 'active' | 'draft' | 'done';
  created_at: string;
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
