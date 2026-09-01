import type { EmbeddingProvider, EmbeddingInputType } from './provider.js';

// Voyage models are multilingual (good for Ukrainian). Output dimensions per
// model; used to size the Qdrant collection. Unknown models fall back to 1024
// (the current default family size) — see dimension resolution below.
const MODEL_DIMENSIONS: Record<string, number> = {
  'voyage-3': 1024,
  'voyage-3.5': 1024,
  'voyage-3.5-lite': 1024,
  'voyage-3-large': 1024,
  'voyage-3-lite': 512,
  'voyage-multilingual-2': 1024,
  'voyage-law-2': 1024,
};

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MAX_BATCH_TEXTS = 64;
// Cap the cumulative characters per request so a batch of long chunks can't blow
// past Voyage's per-request token budget (→ 413 Payload Too Large). ~100k chars
// ≈ 25k tokens, well under the limit, while still batching aggressively.
const MAX_BATCH_CHARS = 100_000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface VoyageResponse {
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
  return exp + Math.random() * 500; // jitter, avoids synchronized retries across concurrent jobs
}

/** Split a batch by BOTH a text count and a cumulative-char budget. */
function batchesOf(texts: string[]): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  for (const t of texts) {
    const len = t.length;
    if (cur.length > 0 && (cur.length >= MAX_BATCH_TEXTS || curChars + len > MAX_BATCH_CHARS)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(t);
    curChars += len;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'voyage';
  readonly dimension: number;
  // Back-compat: the original single collection was named 'documents' (Voyage,
  // 1024-dim). Keep that name so existing indexed vectors are not orphaned.
  readonly collectionName = 'documents';
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimension = MODEL_DIMENSIONS[model] ?? 1024;
  }

  async embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (const batch of batchesOf(texts)) {
      out.push(...(await this.embedBatch(batch, inputType)));
    }
    return out;
  }

  private async embedBatch(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    // Retry transient failures within this single job attempt: HTTP 429/5xx AND
    // network-level errors (ECONNRESET/DNS/TLS/timeout) — the latter throw from
    // fetch rather than returning a status, so they must be caught here too, or
    // they escape as an unhandled rejection. Voyage's per-minute limit rarely
    // clears in BullMQ's coarse job-level retry, so absorb it with backoff+jitter.
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(VOYAGE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ input: texts, model: this.model, input_type: inputType }),
          signal: controller.signal,
        });

        if (res.ok) {
          const json = (await res.json()) as VoyageResponse;
          if (!Array.isArray(json.data)) {
            throw new Error('Voyage embeddings: unexpected response shape (no data[])');
          }
          // Sort by index to guarantee alignment with the input order.
          return json.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);
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
      } catch (err) {
        // A thrown lastError (non-retryable HTTP or exhausted retries) re-throws.
        if (err === lastError) throw err;
        // Network-level error (abort/timeout, ECONNRESET, DNS, TLS): retry with backoff.
        lastError = new Error(`Voyage embeddings network error: ${(err as Error).message}`);
        if (attempt === MAX_RETRIES) throw lastError;
        const delay = retryDelayMs(attempt, null);
        // eslint-disable-next-line no-console
        console.warn(
          `Voyage embeddings network error, retrying in ${Math.round(delay)}ms ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES}): ${(err as Error).message}`,
        );
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error('Voyage embeddings failed after retries');
  }
}
