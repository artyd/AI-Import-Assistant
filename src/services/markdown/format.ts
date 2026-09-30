/**
 * Pure Markdown helpers for the ingest-time conversion (no I/O, unit-tested).
 *
 * - `rowsToMarkdownTable` — spreadsheet rows → a GFM table.
 * - `htmlToMarkdown`      — mammoth's .docx HTML → Markdown (headings, lists,
 *                            tables, bold/italic). mammoth emits a small, regular
 *                            tag set, so a focused converter beats a DOM dependency.
 * - `splitVisionPages`    — split Claude's per-batch transcription on the
 *                            `<!-- стор. N -->` markers it was asked to emit.
 */

export interface MarkdownPage {
  /** 1-indexed page for paged formats (PDF); null for docx/xlsx/csv/md/image. */
  page: number | null;
  markdown: string;
}

function escapeCell(v: string): string {
  return v.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Spreadsheet rows → GFM table. The first non-empty row is the header. */
export function rowsToMarkdownTable(rows: unknown[][]): string {
  const clean = rows
    .map((r) => r.map((c) => (c === null || c === undefined ? '' : escapeCell(String(c)))))
    .filter((r) => r.some((c) => c !== ''));
  if (clean.length === 0) return '';
  const width = Math.max(...clean.map((r) => r.length));
  // Drop fully-empty trailing columns (common in exported sheets).
  let used = width;
  while (used > 0 && clean.every((r) => (r[used - 1] ?? '') === '')) used--;
  const pad = (r: string[]): string[] => Array.from({ length: used }, (_, i) => r[i] ?? '');
  const [head, ...body] = clean.map(pad);
  const line = (r: string[]): string => `| ${r.join(' | ')} |`;
  return [line(head!), line(head!.map(() => '---')), ...body.map(line)].join('\n');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Inline HTML → Markdown text (bold/italic/links/br), all other tags stripped. */
function inline(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, (_m, _t, t: string) => (t.trim() ? `**${t.trim()}**` : ''))
      .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, (_m, _t, t: string) => (t.trim() ? `*${t.trim()}*` : ''))
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) =>
        href.startsWith('#') ? t : `[${t}](${href})`,
      )
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function tableToMarkdown(tableHtml: string): string {
  const rows: string[][] = [];
  for (const tr of tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      // Paragraphs inside a cell become " / " so the row stays on one line.
      inline((m[1] ?? '').replace(/<\/p>\s*<p[^>]*>/gi, ' / ')),
    );
    rows.push(cells);
  }
  return rowsToMarkdownTable(rows);
}

/** mammoth .docx HTML → Markdown. */
export function htmlToMarkdown(html: string): string {
  const blocks: string[] = [];
  // Tables first (placeholder), so their inner <p>s aren't treated as paragraphs.
  const tables: string[] = [];
  let body = html.replace(/<table[\s\S]*?<\/table>/gi, (t) => {
    tables.push(tableToMarkdown(t));
    return `\n@@TABLE${tables.length - 1}@@\n`;
  });

  body = body
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n${'#'.repeat(Number(n))} ${inline(t)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t: string) => `\n- ${inline(t)}\n`)
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, t: string) => `\n${inline(t)}\n`);

  for (const raw of body.split(/\n/)) {
    const line = raw.trim();
    if (!line) {
      if (blocks.length && blocks[blocks.length - 1] !== '') blocks.push('');
      continue;
    }
    const tm = /^@@TABLE(\d+)@@$/.exec(line);
    if (tm) {
      blocks.push('', tables[Number(tm[1])] ?? '', '');
      continue;
    }
    // Leftover inline markup outside any block element.
    blocks.push(line.startsWith('#') || line.startsWith('- ') ? line : inline(line));
  }
  return blocks
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const PAGE_MARKER = /<!--\s*стор\.?\s*(\d+)\s*-->/gi;

/**
 * Splits a vision transcription of pages [from..to] on its `<!-- стор. N -->`
 * markers. Markers outside the batch range are ignored; if the model emitted no
 * usable markers the whole text is attributed to the batch's first page (never
 * dropped). Empty pages are omitted.
 */
export function splitVisionPages(text: string, from: number, to: number): MarkdownPage[] {
  const marks = [...text.matchAll(PAGE_MARKER)]
    .map((m) => ({ page: Number(m[1]), at: m.index ?? 0, len: m[0].length }))
    .filter((m) => m.page >= from && m.page <= to);
  if (marks.length === 0) {
    const md = text.trim();
    return md ? [{ page: from, markdown: md }] : [];
  }
  const out: MarkdownPage[] = [];
  const preamble = text.slice(0, marks[0]!.at).trim();
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.at : text.length;
    let md = text.slice(m.at + m.len, end).trim();
    if (i === 0 && preamble) md = `${preamble}\n\n${md}`.trim();
    if (!md) return;
    const prev = out.find((p) => p.page === m.page);
    if (prev) prev.markdown += `\n\n${md}`;
    else out.push({ page: m.page, markdown: md });
  });
  return out;
}

/** Joins pages into one Markdown document with page headers (what read_file shows). */
export function joinPages(pages: MarkdownPage[]): string {
  return pages.map((p) => (p.page !== null ? `--- стор. ${p.page} ---\n${p.markdown}` : p.markdown)).join('\n\n');
}

/**
 * Groups pages into parts of at most `maxChars` (by page boundary; an oversized
 * single page is hard-split). Used for multi-pass extraction of long documents.
 */
export function groupPagesByChars(pages: MarkdownPage[], maxChars: number): MarkdownPage[][] {
  const parts: MarkdownPage[][] = [];
  let cur: MarkdownPage[] = [];
  let size = 0;
  const flush = (): void => {
    if (cur.length) parts.push(cur);
    cur = [];
    size = 0;
  };
  for (const p of pages) {
    if (p.markdown.length > maxChars) {
      flush();
      for (let i = 0; i < p.markdown.length; i += maxChars) {
        parts.push([{ page: p.page, markdown: p.markdown.slice(i, i + maxChars) }]);
      }
      continue;
    }
    if (size + p.markdown.length > maxChars) flush();
    cur.push(p);
    size += p.markdown.length;
  }
  flush();
  return parts;
}
