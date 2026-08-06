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

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
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
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.EMBEDDING_API_KEY}`,
      },
      body: JSON.stringify({ input: texts, model: this.model, input_type: inputType }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Voyage embeddings failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as VoyageResponse;
    // Sort by index to guarantee alignment with the input order.
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
