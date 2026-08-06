import { QdrantClient } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { getEmbeddingProvider } from './embeddings/index.js';

export const COLLECTION = 'documents';

export const qdrant = new QdrantClient({
  url: config.QDRANT_URL,
  apiKey: config.QDRANT_API_KEY,
});

export interface ChunkPayload {
  workspace_id: string;
  file_id: string;
  file_name: string;
  folder: string | null;
  chunk_index: number;
  page: number | null;
  text: string;
}

/**
 * Creates the single shared collection if absent, sized to the embedding
 * provider's dimension, with payload indexes for the fields we filter on.
 */
export async function ensureQdrantCollection(): Promise<void> {
  const { collections } = await qdrant.getCollections();
  if (collections.some((c) => c.name === COLLECTION)) return;

  const dimension = getEmbeddingProvider().dimension;
  await qdrant.createCollection(COLLECTION, {
    vectors: { size: dimension, distance: 'Cosine' },
  });
  await qdrant.createPayloadIndex(COLLECTION, { field_name: 'workspace_id', field_schema: 'keyword' });
  await qdrant.createPayloadIndex(COLLECTION, { field_name: 'file_id', field_schema: 'keyword' });
}

export async function upsertChunks(
  vectors: number[][],
  payloads: ChunkPayload[],
): Promise<void> {
  if (vectors.length === 0) return;
  const points = vectors.map((vector, i) => ({
    id: uuidv4(),
    vector,
    payload: payloads[i] as unknown as Record<string, unknown>,
  }));
  await qdrant.upsert(COLLECTION, { wait: true, points });
}

/** Removes all chunk vectors belonging to a file (used on re-index / delete). */
export async function deleteFileChunks(fileId: string): Promise<void> {
  await qdrant.delete(COLLECTION, {
    wait: true,
    filter: { must: [{ key: 'file_id', match: { value: fileId } }] },
  });
}

export interface SearchHit {
  file: string;
  fileId: string;
  page: number | null;
  folder: string | null;
  text: string;
  score: number;
}

/** Semantic search over a single workspace's chunks. */
export async function searchWorkspace(
  workspaceId: string,
  query: string,
  limit = 6,
): Promise<SearchHit[]> {
  const [vector] = await getEmbeddingProvider().embed([query], 'query');
  if (!vector) return [];
  const results = await qdrant.search(COLLECTION, {
    vector,
    limit,
    with_payload: true,
    filter: { must: [{ key: 'workspace_id', match: { value: workspaceId } }] },
  });
  return results.map((r) => {
    const p = r.payload as unknown as ChunkPayload;
    return {
      file: p.file_name,
      fileId: p.file_id,
      page: p.page ?? null,
      folder: p.folder ?? null,
      text: p.text,
      score: r.score,
    };
  });
}
