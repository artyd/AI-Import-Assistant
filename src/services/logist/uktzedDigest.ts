import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { anthropic } from '../../anthropic/client.js';
import { runWithAnthropicLimit } from '../../anthropic/limiter.js';
import { config } from '../../config.js';
import { createRedis } from '../../queue/connection.js';
import type { UktzedTab } from './index.js';

/**
 * Batched, regime-aware digest of a full УКТ ЗЕД goodinfo page.
 *
 * The qdpro goodinfo page splits its content into customs-regime tabs — ІМПОРТ /
 * ЕКСПОРТ / ТРАНЗИТ — plus a shared header (code description, tariff, common
 * notes). Each regime is large and its decision-critical parts sit deep (ПДВ,
 * ліцензування, ветеринарно-санітарний контроль with document codes 0853/5514/
 * 5509, заборони). Returning a head-truncated slice loses whole requirements, and
 * feeding an entire section to the model in ONE pass invites "lost in the middle"
 * skimming of exactly those deep parts.
 *
 * So we digest EACH section (common + every regime tab) separately and, for a
 * large section, split it into overlapping chunks extracted in parallel (same
 * batching idea as the consolidated-analysis engine). The result is a compact,
 * COMPLETE, regime-labelled base — the agent can attribute each requirement to
 * import vs export vs transit. The Anthropic key stays server-side (backend).
 */

// Sections at or below this size are handed over verbatim — no batching needed.
const DIGEST_THRESHOLD = 12_000;
// Chars per batch + a small overlap so a requirement straddling a boundary isn't
// dropped by either neighbour.
const CHUNK_CHARS = 12_000;
const OVERLAP_CHARS = 400;
// Safety bound on batches per section.
const MAX_CHUNKS = 8;
// Concurrency: sections in parallel × chunks in parallel, both bounded.
const SECTION_CONCURRENCY = 3;
const CHUNK_CONCURRENCY = 3;
// Room for adaptive thinking (effort low) plus the bullet list.
const CHUNK_MAX_TOKENS = 4000;
// Tariff/requirements pages change rarely — reuse a digest for a day.
const CACHE_TTL_S = 24 * 60 * 60;

const chunkInstruction = (code: string, section: string): string =>
  `Це фрагмент розділу «${section}» ОФІЦІЙНОЇ митної довідки по коду УКТ ЗЕД ${code} ` +
  '(джерело: qdpro.com.ua, дані ДФС/Мінфіну). Витягни СТИСЛО, українською, маркованим ' +
  'списком УСЕ релевантне, що є САМЕ В ЦЬОМУ фрагменті:\n' +
  '- ставки мита (пільгова і повна), ПДВ, акциз;\n' +
  '- пільгові ставки за торговими угодами (ЄС, ЄАВТ, Канада, Британія/UK, ОАЕ тощо);\n' +
  '- ліцензування, дозволи, квоти;\n' +
  '- заборони (напр. заборона ввезення товарів походженням з РФ) та обмеження;\n' +
  '- заходи контролю (ветеринарно-санітарний, санітарно-епідеміологічний, фітосанітарний, ' +
  'радіологічний, екологічний) — ОБОВʼЯЗКОВО з кодами документів (напр. 0853, 5514, 5509) і тим, ' +
  'що кожен документ означає та коли застосовується;\n' +
  '- технічні регламенти, сертифікати відповідності;\n' +
  '- наркотичні засоби / прекурсори, товари подвійного використання;\n' +
  '- правові підстави (постанови КМУ, закони) і дати набрання чинності, якщо вказані.\n' +
  'Пиши ДОСЛІВНО суть із фрагмента; нічого не додумуй понад текст. ' +
  'Якщо у ЦЬОМУ фрагменті немає нічого релевантного — відповідай рівно одним символом: —';

/** Split into overlapping char windows, preferring to cut on a newline near the edge. */
function splitChunks(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > start + CHUNK_CHARS - 800) end = nl;
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }
  return chunks;
}

async function summarizeChunk(code: string, section: string, chunk: string): Promise<string> {
  // Verbatim extraction into bullets — Sonnet at low effort, not the chat Opus;
  // under the shared Anthropic concurrency limit like every other call.
  const msg = await runWithAnthropicLimit(() =>
    anthropic.messages.create({
      model: config.LOGIST_DIGEST_MODEL,
      max_tokens: CHUNK_MAX_TOKENS,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: `${chunkInstruction(code, section)}\n\n---\n${chunk}` }],
    }),
  );
  return msg.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}

/** Run an async mapper with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Digest ONE section (batched if large). Returns '' if it yields nothing. */
async function digestSection(code: string, section: string, text: string): Promise<string> {
  const t = text.trim();
  if (!t) return '';
  if (t.length <= DIGEST_THRESHOLD) return t;
  const chunks = splitChunks(t);
  const parts = await mapLimit(chunks, CHUNK_CONCURRENCY, (c) =>
    summarizeChunk(code, section, c).catch(() => ''),
  );
  const merged = parts.map((p) => p.trim()).filter((p) => p && p !== '—').join('\n');
  return merged || t.slice(0, DIGEST_THRESHOLD);
}

/**
 * Produce a compact, COMPLETE, regime-labelled digest of a goodinfo page.
 * `common` is the shared header; `tabs` are the per-regime views. If everything
 * fails, returns '' and the caller falls back to a plain message.
 */
let cache: Redis | null = null;
function getCache(): Redis {
  if (!cache) cache = createRedis();
  return cache;
}

export async function digestUktzedSections(
  code: string,
  common: string,
  tabs: UktzedTab[],
): Promise<string> {
  // Keyed by the page CONTENT, so a changed tariff page is re-digested at once.
  const key =
    'uktzed_digest:' +
    createHash('sha256').update(JSON.stringify([code, common, tabs])).digest('hex');
  const hit = await getCache().get(key).catch(() => null);
  if (hit !== null) return hit;
  const digest = await buildDigest(code, common, tabs);
  if (digest) await getCache().set(key, digest, 'EX', CACHE_TTL_S).catch(() => undefined);
  return digest;
}

async function buildDigest(code: string, common: string, tabs: UktzedTab[]): Promise<string> {
  const sections: { label: string; text: string }[] = [];
  if (common && common.trim()) {
    sections.push({ label: 'ЗАГАЛЬНЕ (опис товару, тариф, спільні коментарі)', text: common });
  }
  for (const t of tabs) {
    if (t && t.text && t.text.trim()) sections.push({ label: `РЕЖИМ: ${t.label}`, text: t.text });
  }
  if (sections.length === 0) return '';

  const digested = await mapLimit(sections, SECTION_CONCURRENCY, async (s) => {
    try {
      const d = await digestSection(code, s.label, s.text);
      return d ? `## ${s.label}\n${d}` : '';
    } catch {
      return '';
    }
  });
  return digested.filter(Boolean).join('\n\n');
}
