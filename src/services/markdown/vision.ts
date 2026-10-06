import { PDFDocument } from 'pdf-lib';
import { anthropic, type ChatContentBlockParam } from '../../anthropic/client.js';
import { runWithAnthropicLimit } from '../../anthropic/limiter.js';
import { config } from '../../config.js';
import { splitVisionPages, type MarkdownPage } from './format.js';

/**
 * Claude vision → Markdown. Scans, photos AND text PDFs are transcribed by Claude
 * page-by-page into Markdown (tables as GFM tables), in windows of
 * MARKDOWN_PDF_BATCH_PAGES pages per call. Batching removes the old whole-PDF
 * cliffs (32 MB / ~100 pages / one output budget for the entire document) and
 * gives every page its real number.
 */

// Anthropic PDF request limit.
const PDF_MAX_BYTES = 32 * 1024 * 1024;
// Raw bytes allowed in ONE vision window. Base64 inflates by 4/3, so 22 MB raw ≈
// 29 MB on the wire — under the 32 MB request cap. A high-DPI scan (~5 MB/page,
// e.g. a 51 MB signed contract) would otherwise make a 5-page window ~25 MB raw
// → ~33 MB request → rejected, and those pages silently lost.
const WINDOW_MAX_BYTES = 22 * 1024 * 1024;

/** A page window too large for one request — split it and retry. */
class WindowTooLarge extends Error {}

const RULES =
  'Правила: переписуй ДОСЛІВНО, нічого не перекладай, не скорочуй і не вигадуй. ' +
  'Таблиці — у форматі Markdown-таблиць (| … |), по одному рядку документа на рядок таблиці, ' +
  'з заголовками колонок; цифри, суми, ваги, коди, дати, номери — точно як у документі. ' +
  'Заголовки розділів — через #. Печатки, підписи, рукописні позначки — коротко в [квадратних дужках] ' +
  '(напр. [печатка: ТОВ «…»], [підпис]). Нечитабельне — [нерозбірливо]. ' +
  'Не додавай власних коментарів чи вступу — лише вміст документа.';

function batchPrompt(from: number, to: number): string {
  return (
    `Це сторінки ${from}–${to} документа постачання (українською, російською, англійською або іншою мовою). ` +
    'Перепиши їх у Markdown. ПЕРЕД вмістом кожної сторінки постав окремим рядком маркер ' +
    `<!-- стор. N -->, де N — справжній номер сторінки (від ${from} до ${to}). ` +
    RULES
  );
}

const IMAGE_PROMPT =
  'Це фото або скан документа постачання. Перепиши його вміст у Markdown. ' +
  RULES +
  ' Якщо на зображенні немає тексту — поверни порожню відповідь.';

function imageMediaType(name: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const n = name.toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

/**
 * `media` is built LAZILY inside the concurrency slot: slicing a PDF window and
 * base64-encoding it up front for every window at once held a whole large scan
 * (several copies) in memory while calls queued — an OOM risk for the worker.
 */
async function transcribe(
  media: ChatContentBlockParam | (() => Promise<ChatContentBlockParam>),
  prompt: string,
): Promise<{ text: string; truncated: boolean }> {
  const msg = await runWithAnthropicLimit(async () =>
    anthropic.messages.create({
      model: config.OCR_MODEL,
      max_tokens: config.OCR_MAX_TOKENS,
      // Verbatim transcription needs little reasoning — keep thinking cheap.
      // (No `temperature`: current models reject non-default sampling with a 400.)
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'user',
          content: [typeof media === 'function' ? await media() : media, { type: 'text', text: prompt }],
        },
      ],
    }),
  );
  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { text, truncated: msg.stop_reason === 'max_tokens' };
}

function pdfBlock(bytes: Uint8Array): ChatContentBlockParam {
  return {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') },
  };
}

export interface VisionResult {
  pages: MarkdownPage[];
  /** true when some page's transcription hit the output cap even at 1 page/call. */
  partial: boolean;
  /** Pages (1-indexed) that could not be transcribed at all. */
  failedPages: number[];
  pageCount: number;
}

/** Transcribes an image into a single Markdown page. */
export async function imageToMarkdown(buf: Buffer, name: string): Promise<VisionResult> {
  const { text, truncated } = await transcribe(
    { type: 'image', source: { type: 'base64', media_type: imageMediaType(name), data: buf.toString('base64') } },
    IMAGE_PROMPT,
  );
  return { pages: text ? [{ page: null, markdown: text }] : [], partial: truncated, failedPages: [], pageCount: 1 };
}

/**
 * Transcribes a PDF in page windows. A window whose output is truncated is
 * retried page-by-page; a window that errors is recorded in `failedPages` (the
 * caller fills those from the text layer). Throws only if the PDF can't be
 * parsed at all (encrypted/corrupt) AND is too large for a single whole-file call.
 */
export async function pdfToMarkdown(buf: Buffer): Promise<VisionResult> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  } catch (err) {
    // Unsplittable PDF — last resort: one whole-document call (old behaviour).
    if (buf.length > PDF_MAX_BYTES) throw err;
    const { text, truncated } = await transcribe(pdfBlock(buf), batchPrompt(1, 9999));
    return { pages: splitVisionPages(text, 1, 9999), partial: truncated, failedPages: [], pageCount: 0 };
  }

  const pageCount = src.getPageCount();
  const size = Math.max(1, config.MARKDOWN_PDF_BATCH_PAGES);
  const windows: [number, number][] = [];
  for (let from = 1; from <= pageCount; from += size) windows.push([from, Math.min(pageCount, from + size - 1)]);

  const slice = async (from: number, to: number): Promise<Uint8Array> => {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(
      src,
      Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i),
    );
    copied.forEach((p) => out.addPage(p));
    return out.save();
  };

  const runWindow = async (from: number, to: number): Promise<{ pages: MarkdownPage[]; partial: boolean; failed: number[] }> => {
    const perPage = async () => {
      const per = await Promise.all(
        Array.from({ length: to - from + 1 }, (_, i) => runWindow(from + i, from + i)),
      );
      return {
        pages: per.flatMap((r) => r.pages),
        partial: per.some((r) => r.partial),
        failed: per.flatMap((r) => r.failed),
      };
    };
    try {
      const { text, truncated } = await transcribe(async () => {
        const bytes = await slice(from, to);
        if (bytes.length > WINDOW_MAX_BYTES) throw new WindowTooLarge(`${bytes.length}`);
        return pdfBlock(bytes);
      }, batchPrompt(from, to));
      // Output cap hit for the window → redo one page per call.
      if (truncated && to > from) return await perPage();
      return { pages: splitVisionPages(text, from, to), partial: truncated, failed: [] };
    } catch (err) {
      // Too many bytes for one request (high-DPI scan) → one page per call. A
      // single page still over the cap is recorded as failed (text-layer fallback).
      if (err instanceof WindowTooLarge && to > from) return perPage();
      // eslint-disable-next-line no-console
      console.error(`Vision transcription failed for pages ${from}-${to}: ${(err as Error).message}`);
      return { pages: [], partial: false, failed: Array.from({ length: to - from + 1 }, (_, i) => from + i) };
    }
  };

  // Windows run concurrently; the Anthropic semaphore bounds real parallelism.
  const results = await Promise.all(windows.map(([f, t]) => runWindow(f, t)));
  return {
    pages: results.flatMap((r) => r.pages).sort((a, b) => (a.page ?? 0) - (b.page ?? 0)),
    partial: results.some((r) => r.partial),
    failedPages: results.flatMap((r) => r.failed),
    pageCount,
  };
}
