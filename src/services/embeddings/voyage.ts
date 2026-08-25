import { config } from '../../config.js';
import type { EmbeddingProvider, EmbeddingInputType } from './provider.js';

// Voyage models are multilingual (good for Ukrainian). Output dimensions per
// model; used to size the Qdrant collection.
const MODEL_DIMENSIONS: Record<string, number> = {
  'voyage-3': 1024,
  'voyage-3-large': 1024,
  'voyage-3-lite': 512,
  'voyage-multilingual-2': 1024,
};

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const BATCH = 64;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
  }
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return exp + Math.random() * 500; // jitter, avoids synchronized retries across concurrent jobs
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  private readonly model = config.EMBEDDING_MODEL;

  constructor() {
    this.dimension = MODEL_DIMENSIONS[this.model] ?? 1024;
  }

  async embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      out.push(...(await this.embedBatch(batch, inputType)));
    }
    return out;
  }

  private async embedBatch(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    // Retry transient failures (429 rate-limit, 5xx) within this single job
    // attempt — Voyage's per-minute limit rarely clears in BullMQ's coarse
    // 2s job-level retry, so absorb it here with backoff + jitter.
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(VOYAGE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.EMBEDDING_API_KEY}`,
        },
        body: JSON.stringify({ input: texts, model: this.model, input_type: inputType }),
      });

      if (res.ok) {
        const json = (await res.json()) as VoyageResponse;
        // Sort by index to guarantee alignment with the input order.
        return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      }

      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      const body = await res.text().catch(() => '');
      lastError = new Error(`Voyage embeddings failed (${res.status}): ${body.slice(0, 300)}`);

      if (!retryable || attempt === MAX_RETRIES) throw lastError;

      const delay = retryDelayMs(attempt, res.headers.get('retry-after'));
      // eslint-disable-next-line no-console
      console.warn(
        `Voyage embeddings ${res.status}, retrying in ${Math.round(delay)}ms ` +
          `(attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
    }

    throw lastError ?? new Error('Voyage embeddings failed after retries');
  }
}
