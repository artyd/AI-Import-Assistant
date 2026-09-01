import type { EmbeddingProvider, EmbeddingInputType } from './provider.js';

/**
 * OpenAI embeddings provider — used primarily as the FALLBACK embedder when the
 * primary (Voyage) is unavailable. Same hardening as voyage.ts: HTTP + network
 * retry with backoff, per-request timeout, and count/char batching. OpenAI has no
 * asymmetric `input_type`, so it is accepted and ignored.
 */

const OPENAI_URL = 'https://api.openai.com/v1/embeddings';
const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-large': 3072,
  'text-embedding-3-small': 1536,
  'text-embedding-ada-002': 1536,
};

const MAX_BATCH_TEXTS = 64;
const MAX_BATCH_CHARS = 100_000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface OpenAIResponse {
  data?: { embedding: number[]; index: number }[];
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
  return exp + Math.random() * 500;
}

function batchesOf(texts: string[]): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  for (const t of texts) {
    if (cur.length > 0 && (cur.length >= MAX_BATCH_TEXTS || curChars + t.length > MAX_BATCH_CHARS)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(t);
    curChars += t.length;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly dimension: number;
  readonly collectionName: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimension = MODEL_DIMENSIONS[model] ?? 3072;
    // Dimension-specific collection so it never collides with the Voyage one.
    this.collectionName = `documents_openai_${this.dimension}`;
  }

  async embed(texts: string[], _inputType: EmbeddingInputType): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (const batch of batchesOf(texts)) {
      out.push(...(await this.embedBatch(batch)));
    }
    return out;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(OPENAI_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ input: texts, model: this.model }),
          signal: controller.signal,
        });

        if (res.ok) {
          const json = (await res.json()) as OpenAIResponse;
          if (!Array.isArray(json.data)) {
            throw new Error('OpenAI embeddings: unexpected response shape (no data[])');
          }
          return json.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);
        }

        const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        const body = await res.text().catch(() => '');
        lastError = new Error(`OpenAI embeddings failed (${res.status}): ${body.slice(0, 300)}`);
        if (!retryable || attempt === MAX_RETRIES) throw lastError;

        const delay = retryDelayMs(attempt, res.headers.get('retry-after'));
        // eslint-disable-next-line no-console
        console.warn(
          `OpenAI embeddings ${res.status}, retrying in ${Math.round(delay)}ms ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(delay);
      } catch (err) {
        if (err === lastError) throw err;
        lastError = new Error(`OpenAI embeddings network error: ${(err as Error).message}`);
        if (attempt === MAX_RETRIES) throw lastError;
        const delay = retryDelayMs(attempt, null);
        // eslint-disable-next-line no-console
        console.warn(
          `OpenAI embeddings network error, retrying in ${Math.round(delay)}ms ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES}): ${(err as Error).message}`,
        );
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error('OpenAI embeddings failed after retries');
  }
}
