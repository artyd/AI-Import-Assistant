import { query } from '../db/pool.js';
import type { WorkspaceStatus } from './workspaceAccess.js';

/**
 * A collection (Збірник) is an FCL workspace (`workspaces.kind = 'fcl'`, spec 006).
 * The `/api/collections` routes keep their wire shape; this is the row they read.
 */
export interface CollectionRow {
  id: string;
  owner_id: string;
  number: string;
  supplier: string;
  status: WorkspaceStatus;
  created_at: string;
}

/**
 * Loads an FCL only if it belongs to the given user. Returns null when it does not
 * exist, is owned by someone else, or is a plain shipment (callers 404 in all cases).
 */
export async function getOwnedCollection(
  userId: string,
  collectionId: string,
): Promise<CollectionRow | null> {
  const { rows } = await query<CollectionRow>(
    `SELECT id, owner_id, number, supplier, status, created_at FROM workspaces
     WHERE id = $1 AND owner_id = $2 AND kind = 'fcl'`,
    [collectionId, userId],
  );
  return rows[0] ?? null;
}
