import { createHash } from 'node:crypto';
import type { NewsSource, RubricKey } from './sources.js';

/**
 * Pure feed-mapping helpers (no network, no DB, no config) so they can be unit
 * tested in isolation. index.ts does the fetch + rss-parser call and hands the
 * already-parsed items here.
 */

/** Cap the summary so a verbose feed can't bloat a row. */
export const SUMMARY_MAX = 400;

/** The subset of a parsed rss-parser item we consume. */
export interface FeedItem {
  title?: string;
  link?: string;
  summary?: string;
  content?: string;
  contentSnippet?: string;
  pubDate?: string;
  isoDate?: string;
}

export interface NewsRow {
  rubric: RubricKey;
  title: string | null;
  summary: string | null;
  source: string;
  url: string | null;
  publishedAt: Date;
  hash: string;
}

/** Strip HTML tags + decode a handful of common entities, then collapse whitespace. */
export function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSummary(item: FeedItem): string | null {
  const raw = item.contentSnippet ?? item.summary ?? item.content ?? '';
  const text = stripHtml(raw);
  if (!text) return null;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : text;
}

/** sha256(url + '|' + title) — stable dedup key across re-fetches. */
export function hashItem(url: string, title: string): string {
  return createHash('sha256').update(`${url}|${title}`).digest('hex');
}

export function toDate(item: FeedItem): Date {
  const raw = item.isoDate ?? item.pubDate;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // Feed omitted a date (or it was unparseable): fall back to "now" so the item
  // is both visible within the retention window and eventually purgeable.
  return new Date();
}

/** Map parsed feed items to news rows, dropping empties (nothing to key on). */
export function mapItems(src: NewsSource, items: FeedItem[]): NewsRow[] {
  const rows: NewsRow[] = [];
  for (const item of items) {
    const url = item.link?.trim() ?? '';
    const title = item.title?.trim() ?? '';
    if (!url && !title) continue;
    rows.push({
      rubric: src.rubric,
      title: title || null,
      summary: buildSummary(item),
      source: src.name,
      url: url || null,
      publishedAt: toDate(item),
      hash: hashItem(url, title),
    });
  }
  return rows;
}
