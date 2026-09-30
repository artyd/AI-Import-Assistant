/** Pure helpers for Postgres full-text search over document sections (unit-tested). */

/**
 * Builds an OR-ed prefix tsquery from free text. Postgres has no Ukrainian
 * stemmer, so inflection ("інвойсу" / "інвойс", "вантажу" / "вантаж") is handled
 * by prefix-matching a slightly trimmed stem. Returns null when nothing usable.
 */
export function buildTsQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = new Set<string>();
  for (const w of words) {
    // Too short to be selective ("в", "на", "01") — codes still match via substringPatterns.
    if (w.length < 3) continue;
    if (/\d/.test(w) || w.length === 3) terms.add(`${w}:*`);
    else if (w.length >= 7) terms.add(`${w.slice(0, w.length - 2)}:*`);
    else terms.add(`${w.slice(0, w.length - 1)}:*`); // 4–6 chars: drop the ending ("ваги" → "ваг")
  }
  return terms.size ? [...terms].join(' | ') : null;
}

/** Exact-substring patterns for codes/numbers the FTS parser tokenises oddly (UA/19603/01/01, 2941.30.00). */
export function substringPatterns(q: string): string[] {
  const esc = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const out = new Set<string>();
  for (const tok of q.split(/\s+/)) {
    const t = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (t.length >= 4 && /\d/.test(t)) out.add(`%${esc(t)}%`);
  }
  const phrase = q.trim();
  if (phrase.includes(' ') && phrase.length <= 80) out.add(`%${esc(phrase)}%`);
  return [...out];
}

export interface SearchHit {
  file: string;
  fileId: string;
  page: number | null;
  folder: string | null;
  text: string;
  score: number;
}

/**
 * Round-robin the top hits across their source documents so one large document
 * can't occupy every slot and starve the invoice/packing/certs of a shipment.
 */
export function diversifyByDocument(hits: SearchHit[], limit: number, perFileCap: number): SearchHit[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const byFile = new Map<string, SearchHit[]>();
  for (const h of sorted) {
    const arr = byFile.get(h.fileId);
    if (arr) arr.push(h);
    else byFile.set(h.fileId, [h]);
  }
  const out: SearchHit[] = [];
  for (let round = 0; round < perFileCap && out.length < limit; round++) {
    for (const arr of byFile.values()) {
      if (round < arr.length) {
        out.push(arr[round]!);
        if (out.length >= limit) break;
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
