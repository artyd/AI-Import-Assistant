import { config } from '../../config.js';
import type { EmbeddingProvider } from './provider.js';
import { VoyageEmbeddingProvider } from './voyage.js';

let provider: EmbeddingProvider | null = null;

/** Returns the configured embedding provider (singleton). */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (provider) return provider;
  switch (config.EMBEDDING_PROVIDER) {
    case 'voyage':
      provider = new VoyageEmbeddingProvider();
      break;
    default:
      throw new Error(`Unsupported embedding provider: ${config.EMBEDDING_PROVIDER}`);
  }
  return provider;
}

export type { EmbeddingProvider } from './provider.js';
