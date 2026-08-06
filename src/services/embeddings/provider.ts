export type EmbeddingInputType = 'document' | 'query';

/**
 * Provider-agnostic embedding interface. All embedding usage in the codebase
 * goes through this so the vendor (Voyage today) can be swapped by adding one
 * implementation and changing EMBEDDING_PROVIDER — no vendor SDK calls leak
 * elsewhere.
 */
export interface EmbeddingProvider {
  /** Output vector dimension (must match the Qdrant collection size). */
  readonly dimension: number;
  /** Embed a batch of texts. `inputType` lets asymmetric models optimise. */
  embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]>;
}
