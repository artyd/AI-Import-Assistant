import type { Citation } from "./types";

export interface CitationGroup {
  file: string;
  /** Distinct pages, ascending; empty when the file was cited as a whole. */
  pages: number[];
}

/**
 * An answer's citations grouped by file, in first-seen order: one row per file
 * with its pages, instead of a chip per (file, page) — with many sources the chip
 * cloud grew taller than the answer itself.
 */
export function groupCitations(citations: Citation[]): CitationGroup[] {
  const byFile = new Map<string, Set<number>>();
  for (const c of citations) {
    const pages = byFile.get(c.file) ?? new Set<number>();
    if (c.page != null) pages.add(c.page);
    byFile.set(c.file, pages);
  }
  return [...byFile].map(([file, pages]) => ({ file, pages: [...pages].sort((a, b) => a - b) }));
}

/** «с. 1, 2, 4» / «» — the pages of one file. */
export function pagesLabel(pages: number[]): string {
  return pages.length ? `с. ${pages.join(", ")}` : "";
}

/** «3 файли» with the Ukrainian plural. */
export function filesLabel(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  const word = d === 1 && dd !== 11 ? "файл" : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? "файли" : "файлів";
  return `${n} ${word}`;
}
