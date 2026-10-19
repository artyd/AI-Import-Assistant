import { query } from '../db/pool.js';

/** Collection status mirrors the original workspace tri-state (no derived stages). */
export type CollectionStatus = 'active' | 'draft' | 'done';

export const COLLECTION_STATUSES: readonly CollectionStatus[] = [
  'active',
  'draft',
  'done',
] as const;

export interface CollectionRow {
  id: string;
  owner_id: string;
  number: string;
  supplier: string;
  status: CollectionStatus;
  created_at: string;
}

/**
 * Loads a collection only if it belongs to the given user. Returns null when the
 * collection does not exist or is owned by someone else (callers should 404 in
 * both cases — never leak existence of another user's collection).
 */
export async function getOwnedCollection(
  userId: string,
  collectionId: string,
): Promise<CollectionRow | null> {
  const { rows } = await query<CollectionRow>(
    'SELECT * FROM collections WHERE id = $1 AND owner_id = $2',
    [collectionId, userId],
  );
  return rows[0] ?? null;
}
