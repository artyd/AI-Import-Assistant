export type EmbeddingInputType = 'document' | 'query';

/**
 * Provider-agnostic embedding interface. All embedding usage in the codebase
 * goes through this so the vendor can be swapped by adding one implementation
 * and changing EMBEDDING_PROVIDER — no vendor SDK calls leak elsewhere.
 *
 * A deployment can run a PRIMARY provider plus an optional FALLBACK provider of a
 * different dimension. Vectors from different providers cannot share one Qdrant
 * collection, so each provider owns its own collection (`collectionName`); search
 * queries every provider's collection and merges. See services/embeddings/index.ts.
 */
export interface EmbeddingProvider {
  /** Stable id for logging / payload provenance (e.g. 'voyage', 'openai'). */
  readonly id: string;
  /** Output vector dimension (must match this provider's Qdrant collection size). */
  readonly dimension: number;
  /** Qdrant collection this provider's vectors live in (dimension-specific). */
  readonly collectionName: string;
  /** Embed a batch of texts. `inputType` lets asymmetric models optimise. */
  embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]>;
}
