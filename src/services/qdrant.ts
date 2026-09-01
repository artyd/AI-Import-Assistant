import { QdrantClient } from '@qdrant/js-client-rest';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { getAllEmbeddingProviders } from './embeddings/index.js';

// Legacy single-collection name; still used by the Voyage provider for back-compat.
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
  provider?: string; // which embedding provider produced this vector
}

/** Distinct collection names across all configured providers. */
function providerCollections(): string[] {
  return Array.from(new Set(getAllEmbeddingProviders().map((p) => p.collectionName)));
}

async function ensureCollection(name: string, dimension: number): Promise<void> {
  const { collections } = await qdrant.getCollections();
  if (collections.some((c) => c.name === name)) return;
  await qdrant.createCollection(name, { vectors: { size: dimension, distance: 'Cosine' } });
  await qdrant.createPayloadIndex(name, { field_name: 'workspace_id', field_schema: 'keyword' });
  await qdrant.createPayloadIndex(name, { field_name: 'file_id', field_schema: 'keyword' });
}

/**
 * Creates one collection per configured provider (sized to that provider's
 * dimension), each with payload indexes for the fields we filter on. Idempotent.
 */
export async function ensureQdrantCollection(): Promise<void> {
  for (const provider of getAllEmbeddingProviders()) {
    await ensureCollection(provider.collectionName, provider.dimension);
  }
}

/** Upserts vectors into the given provider's collection. */
export async function upsertChunks(
  vectors: number[][],
  payloads: ChunkPayload[],
  collectionName: string,
): Promise<void> {
  if (vectors.length === 0) return;
  const points = vectors.map((vector, i) => ({
    id: uuidv4(),
    vector,
    payload: payloads[i] as unknown as Record<string, unknown>,
  }));
  await qdrant.upsert(collectionName, { wait: true, points });
}

/** Removes all chunk vectors belonging to a file across every collection. */
export async function deleteFileChunks(fileId: string): Promise<void> {
  for (const name of providerCollections()) {
    await qdrant
      .delete(name, { wait: true, filter: { must: [{ key: 'file_id', match: { value: fileId } }] } })
      .catch(() => undefined); // collection may not exist yet — ignore
  }
}

/** Removes every chunk vector in a workspace across every collection. */
export async function deleteWorkspaceChunks(workspaceId: string): Promise<void> {
  for (const name of providerCollections()) {
    await qdrant
      .delete(name, {
        wait: true,
        filter: { must: [{ key: 'workspace_id', match: { value: workspaceId } }] },
      })
      .catch(() => undefined);
  }
}

export interface SearchHit {
  file: string;
  fileId: string;
  page: number | null;
  folder: string | null;
  text: string;
  score: number;
}

/**
 * Semantic search over a single workspace's chunks. Queries EVERY configured
 * provider's collection (each with a query vector from that same provider) and
 * merges by score, so results stay complete even if some files were indexed by
 * the fallback provider during a primary outage. A provider that is down at query
 * time is skipped (degrade, not fail) rather than aborting the whole search.
 */
export async function searchWorkspace(
  workspaceId: string,
  query: string,
  limit = 6,
): Promise<SearchHit[]> {
  const filter = { must: [{ key: 'workspace_id', match: { value: workspaceId } }] };
  const hits: SearchHit[] = [];

  for (const provider of getAllEmbeddingProviders()) {
    try {
      const [vector] = await provider.embed([query], 'query');
      if (!vector) continue;
      const results = await qdrant.search(provider.collectionName, {
        vector,
        limit,
        with_payload: true,
        filter,
      });
      for (const r of results) {
        const p = r.payload as unknown as ChunkPayload;
        hits.push({
          file: p.file_name,
          fileId: p.file_id,
          page: p.page ?? null,
          folder: p.folder ?? null,
          text: p.text,
          score: r.score,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Search skipped provider '${provider.id}': ${(err as Error).message}`);
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
