import type { ExtractedPage } from './index.js';

export interface Chunk {
  index: number;
  page: number | null;
  text: string;
}

// Roughly 500–1000 tokens per chunk with overlap. We approximate tokens by
// characters (~4 chars/token) rather than tokenizing, which is fine for
// chunk-boundary purposes.
const TARGET_CHARS = 3200; // ~800 tokens
const OVERLAP_CHARS = 400; // ~100 tokens

/**
 * Splits extracted pages into overlapping chunks, keeping each chunk on a
 * single page so its citation (file + page) stays precise.
 */
export function chunkPages(pages: ExtractedPage[]): Chunk[] {
  const chunks: Chunk[] = [];
  let index = 0;
  for (const { page, text } of pages) {
    const pieces = splitText(text);
    // Carry the page's first line (usually a table/section header) into
    // continuation chunks, so search hits from a split wide table keep their
    // column labels instead of returning header-less data rows.
    const header = pageHeader(text);
    pieces.forEach((piece, i) => {
      const withHeader = i > 0 && header && !piece.startsWith(header) ? `${header}\n${piece}` : piece;
      chunks.push({ index: index++, page, text: withHeader });
    });
  }
  return chunks;
}

/** First non-empty line of a page, if it's short enough to be a header. */
function pageHeader(text: string): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t.length <= 120 ? t : null;
  }
  return null;
}

function splitText(text: string): string[] {
  const clean = text.replace(/\s+\n/g, '\n').trim();
  if (clean.length <= TARGET_CHARS) return clean ? [clean] : [];

  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + TARGET_CHARS, clean.length);
    // Prefer to break on a paragraph/sentence boundary near the target.
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf('\n'),
      );
      if (breakAt > TARGET_CHARS * 0.5) end = start + breakAt + 1;
    }
    out.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }
  return out.filter((c) => c.length > 0);
}
