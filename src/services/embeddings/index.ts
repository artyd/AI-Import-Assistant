import { config } from '../../config.js';
import type { EmbeddingProvider } from './provider.js';
import { VoyageEmbeddingProvider } from './voyage.js';
import { OpenAIEmbeddingProvider } from './openai.js';

/**
 * Embedding provider wiring. A deployment has one PRIMARY provider and an
 * optional FALLBACK provider (a different vendor, typically OpenAI) used only
 * when the primary is unavailable during indexing. Because the two vendors emit
 * different-dimension vectors, each owns a separate Qdrant collection; search
 * queries every configured provider's collection and merges the results.
 */

function build(
  vendor: 'voyage' | 'openai',
  apiKey: string,
  model: string,
): EmbeddingProvider {
  switch (vendor) {
    case 'voyage':
      return new VoyageEmbeddingProvider(apiKey, model);
    case 'openai':
      return new OpenAIEmbeddingProvider(apiKey, model);
    default:
      throw new Error(`Unsupported embedding provider: ${vendor as string}`);
  }
}

let primary: EmbeddingProvider | null = null;
let fallback: EmbeddingProvider | null | undefined; // undefined = not yet resolved

/** Returns the configured PRIMARY embedding provider (singleton). */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!primary) {
    primary = build(config.EMBEDDING_PROVIDER, config.EMBEDDING_API_KEY, config.EMBEDDING_MODEL);
  }
  return primary;
}

/** Returns the FALLBACK provider if configured and usable, else null (singleton). */
export function getFallbackEmbeddingProvider(): EmbeddingProvider | null {
  if (fallback !== undefined) return fallback;
  const vendor = config.EMBEDDING_FALLBACK_PROVIDER;
  const key = config.EMBEDDING_FALLBACK_API_KEY;
  if (!vendor || vendor === 'none' || !key) {
    fallback = null;
  } else {
    fallback = build(vendor, key, config.EMBEDDING_FALLBACK_MODEL);
  }
  return fallback;
}

/** Primary + fallback, de-duplicated by collection (so search never double-scans). */
export function getAllEmbeddingProviders(): EmbeddingProvider[] {
  const all = [getEmbeddingProvider()];
  const fb = getFallbackEmbeddingProvider();
  if (fb && fb.collectionName !== all[0]!.collectionName) all.push(fb);
  return all;
}

export interface IndexEmbedResult {
  vectors: number[][];
  provider: EmbeddingProvider;
}

/**
 * Embeds document chunks for indexing, failing over to the fallback provider if
 * the primary throws (after its own internal retries). Returns the vectors AND
 * the provider that produced them so the caller upserts into the right
 * collection. Throws only if every configured provider fails.
 */
export async function embedForIndex(texts: string[]): Promise<IndexEmbedResult> {
  const providers = getAllEmbeddingProviders();
  let lastError: Error | null = null;
  for (const provider of providers) {
    try {
      const vectors = await provider.embed(texts, 'document');
      if (provider !== providers[0]) {
        // eslint-disable-next-line no-console
        console.warn(`Embeddings: primary failed, used fallback provider '${provider.id}'.`);
      }
      return { vectors, provider };
    } catch (err) {
      lastError = err as Error;
      // eslint-disable-next-line no-console
      console.error(`Embeddings provider '${provider.id}' failed: ${(err as Error).message}`);
    }
  }
  throw lastError ?? new Error('No embedding provider available');
}

export type { EmbeddingProvider } from './provider.js';
