import Parser from 'rss-parser';
import { config } from '../../config.js';
import { query } from '../../db/pool.js';
import { NEWS_SOURCES, type NewsSource } from './sources.js';
import { mapItems, type FeedItem, type NewsRow } from './parse.js';

/**
 * Live RSS/Atom news ingest with retention.
 *
 *  - ingestNews()   iterates NEWS_SOURCES, fetches + parses each feed with a
 *                   per-feed try/catch (one bad feed never aborts the run), maps
 *                   items to rows and upserts them (ON CONFLICT (hash) DO NOTHING).
 *  - purgeOldNews() deletes rows older than NEWS_RETENTION_DAYS.
 *
 * Runs only from the worker cron (src/queue/news.ts) — never at build/test time.
 * The pure mapping helpers live in ./parse.ts (unit tested there).
 */

const parser = new Parser();

/** Per-feed HTTP timeout (ms). A slow feed should not stall the whole run. */
const FEED_TIMEOUT_MS = 15_000;

// A browser-like User-Agent. Several official gov/EU feeds (НБУ, EMA, ECHA,
// Rotterdam, Loadstar…) sit behind Cloudflare/WAF and 403 an obvious bot UA, but
// serve the same public RSS to a normal browser UA — which reading a public feed
// server-side legitimately is. Feeds that still refuse simply fail their turn
// (tolerated per-feed); the run always completes.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

/** Fetch a feed URL as text with a hard timeout + a browser-like User-Agent. */
async function fetchFeed(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': BROWSER_UA,
        accept:
          'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
        'accept-language': 'uk,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch + parse one source into candidate rows. Throws on any feed-level error. */
async function loadSource(src: NewsSource): Promise<NewsRow[]> {
  const xml = await fetchFeed(src.url);
  const feed = await parser.parseString(xml);
  return mapItems(src, feed.items as FeedItem[]);
}

async function upsertRows(rows: NewsRow[]): Promise<number> {
  let inserted = 0;
  for (const r of rows) {
    const res = await query(
      `INSERT INTO news_items (rubric, title, summary, source, url, published_at, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (hash) DO NOTHING`,
      [r.rubric, r.title, r.summary, r.source, r.url, r.publishedAt, r.hash],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Fetch every source, upsert new items. Individual feed failures are logged and
 * skipped — the run always completes. Returns totals for the caller to log.
 */
export async function ingestNews(): Promise<{ inserted: number; ok: number; failed: number }> {
  let inserted = 0;
  let ok = 0;
  let failed = 0;
  for (const src of NEWS_SOURCES) {
    try {
      const rows = await loadSource(src);
      inserted += await upsertRows(rows);
      ok += 1;
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`News feed failed [${src.rubric}] ${src.name} (${src.url}):`, (err as Error).message);
    }
  }
  return { inserted, ok, failed };
}

/** Delete items older than NEWS_RETENTION_DAYS. Returns the number of rows removed. */
export async function purgeOldNews(): Promise<number> {
  const res = await query(
    `DELETE FROM news_items WHERE published_at < now() - ($1 || ' days')::interval`,
    [String(config.NEWS_RETENTION_DAYS)],
  );
  return res.rowCount ?? 0;
}
