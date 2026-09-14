import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { RUBRIC_KEYS, isRubricKey, type RubricKey } from '../services/news/sources.js';

const querySchema = z.object({
  // Omitted or 'all' ⇒ every rubric. Any of the 8 keys ⇒ that rubric only.
  rubric: z.string().optional(),
});

interface NewsItemRow {
  id: string;
  rubric: string;
  title: string | null;
  summary: string | null;
  source: string | null;
  url: string | null;
  published_at: Date | null;
}

interface NewsItem {
  id: string;
  rubric: string;
  title: string | null;
  summary: string | null;
  source: string | null;
  url: string | null;
  published_at: string | null;
}

// Only ever surface news from within the retention window; the interval is built
// from NEWS_RETENTION_DAYS (validated positive int in config).
const WINDOW = `now() - (${config.NEWS_RETENTION_DAYS} || ' days')::interval`;
/** Hard cap on returned items so a big backlog can't produce an unbounded page. */
const ITEMS_LIMIT = 200;

export async function newsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/news?rubric=<key> — fresh news (≤ NEWS_RETENTION_DAYS), newest first.
  // Returns { items, counts } where counts has per-rubric totals + a `total`,
  // both computed over the same retention window.
  app.get('/api/news', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query parameters' });
    }
    const rubricParam = parsed.data.rubric?.trim().toLowerCase();
    const filter: RubricKey | null =
      rubricParam && rubricParam !== 'all' && isRubricKey(rubricParam) ? rubricParam : null;

    const itemsSql = filter
      ? `SELECT id, rubric, title, summary, source, url, published_at
           FROM news_items
          WHERE published_at >= ${WINDOW} AND rubric = $1
          ORDER BY published_at DESC
          LIMIT ${ITEMS_LIMIT}`
      : `SELECT id, rubric, title, summary, source, url, published_at
           FROM news_items
          WHERE published_at >= ${WINDOW}
          ORDER BY published_at DESC
          LIMIT ${ITEMS_LIMIT}`;

    const [{ rows: itemRows }, { rows: countRows }] = await Promise.all([
      query<NewsItemRow>(itemsSql, filter ? [filter] : []),
      query<{ rubric: string; n: string }>(
        `SELECT rubric, count(*)::int AS n
           FROM news_items
          WHERE published_at >= ${WINDOW}
          GROUP BY rubric`,
      ),
    ]);

    const items: NewsItem[] = itemRows.map((r) => ({
      id: r.id,
      rubric: r.rubric,
      title: r.title,
      summary: r.summary,
      source: r.source,
      url: r.url,
      published_at: r.published_at ? r.published_at.toISOString() : null,
    }));

    // Seed every known rubric to 0 so the FE filter bar always has a full set.
    const counts: Record<string, number> = {};
    for (const k of RUBRIC_KEYS) counts[k] = 0;
    let total = 0;
    for (const row of countRows) {
      const n = Number(row.n);
      if (isRubricKey(row.rubric)) counts[row.rubric] = n;
      total += n;
    }
    counts.total = total;

    return reply.send({ items, counts });
  });
}
