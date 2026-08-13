import { anthropic, type ChatContentBlockParam } from '../../anthropic/client.js';
import { config } from '../../config.js';
import type { FileType } from '../../domain/folders.js';
import type { ExtractedPage } from '../extract/index.js';

/**
 * OCR fallback via Claude vision. Used by the indexing worker when a document has
 * no text layer — a scanned PDF (pdf-parse returns nothing) or an image file.
 * Claude reads the pages directly (PDFs go in as a `document` block, images as an
 * `image` block — both server-side, key never leaves the backend) and returns the
 * transcribed text, which then flows through the normal chunk → embed → Qdrant and
 * structured-extraction path, so scans become searchable and reconcilable.
 *
 * Out of scope for this pass: per-page boundaries (returns one page, page=null)
 * and huge documents (bounded by the API's 32 MB request limit + max_tokens).
 */

// Anthropic PDF request limit; images are already bounded by MAX_UPLOAD_BYTES.
const PDF_MAX_BYTES = 32 * 1024 * 1024;

const PROMPT =
  'Це відсканований документ постачання (можливо українською, російською або ' +
  'англійською). Розпізнай і поверни ВЕСЬ текст дослівно, зберігаючи порядок і ' +
  'таблиці (кожен рядок таблиці — окремим рядком, значення через табуляцію). ' +
  'Не перекладай, не додавай коментарів чи заголовків від себе, не вигадуй ' +
  'відсутніх даних. Якщо тексту немає (порожнє фото) — поверни порожній рядок.';

function imageMediaType(name: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const n = name.toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

/** Transcribe a scanned PDF or image to text. Returns [] when OCR is disabled,
 *  the type is unsupported, the file is too large, or nothing was read. */
export async function ocrDocument(
  buf: Buffer,
  type: FileType,
  name: string,
): Promise<ExtractedPage[]> {
  if (!config.OCR_ENABLED) return [];

  let media: ChatContentBlockParam;
  if (type === 'pdf') {
    if (buf.length > PDF_MAX_BYTES) return [];
    media = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
    };
  } else if (type === 'image') {
    media = {
      type: 'image',
      source: { type: 'base64', media_type: imageMediaType(name), data: buf.toString('base64') },
    };
  } else {
    return [];
  }

  const msg = await anthropic.messages.create({
    model: config.OCR_MODEL,
    max_tokens: 8000,
    messages: [{ role: 'user', content: [media, { type: 'text', text: PROMPT }] }],
  });

  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return text ? [{ page: null, text }] : [];
}
