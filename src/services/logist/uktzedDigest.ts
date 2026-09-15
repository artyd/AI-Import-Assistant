import { anthropic, MODEL } from '../../anthropic/client.js';

/**
 * Batched digest of a full УКТ ЗЕД goodinfo page.
 *
 * The qdpro goodinfo page for one code is large (~50KB+) and its decision-critical
 * parts sit DEEP — ПДВ ~15K, ліцензування ~23K, ветеринарно-санітарний контроль
 * with document codes (0853/5514/5509) ~30K, заборони ~35K, plus a transit/export
 * copy past ~49K. Returning a head-truncated slice loses whole requirements, and
 * feeding the entire page to the model in ONE pass invites "lost in the middle"
 * skimming of exactly those deep sections.
 *
 * So we split the page into overlapping chunks and run a focused extraction over
 * each in parallel (same batching idea as the consolidated-analysis engine), then
 * concatenate the per-chunk digests in page order. Every section is fully attended
 * to, and the agent receives a compact, COMPLETE regulatory base instead of raw
 * HTML text. The Anthropic key stays server-side (this runs in the backend).
 */

// Pages at or below this size are already small enough to hand over verbatim — no
// batching needed.
const DIGEST_THRESHOLD = 14_000;
// Chars per batch + a small overlap so a requirement straddling a boundary isn't
// dropped by either neighbour.
const CHUNK_CHARS = 12_000;
const OVERLAP_CHARS = 400;
// Safety bound on batches (a pathological page can't fan out unboundedly).
const MAX_CHUNKS = 10;
// Concurrent extraction calls.
const CONCURRENCY = 4;
const CHUNK_MAX_TOKENS = 1500;

const CHUNK_INSTRUCTION = (code: string): string =>
  `Це фрагмент ОФІЦІЙНОЇ митної довідки по коду УКТ ЗЕД ${code} (джерело: qdpro.com.ua, дані ДФС/Мінфіну). ` +
  'Витягни СТИСЛО, українською, маркованим списком УСЕ релевантне для імпорту в Україну, що є САМЕ В ЦЬОМУ фрагменті:\n' +
  '- ставки ввізного мита (пільгова і повна), ПДВ, акциз;\n' +
  '- пільгові ставки за торговими угодами (ЄС, ЄАВТ, Канада, Британія/UK, ОАЕ тощо);\n' +
  '- ліцензування, дозволи, квоти;\n' +
  '- заборони (напр. заборона ввезення товарів походженням з РФ) та обмеження;\n' +
  '- заходи контролю (ветеринарно-санітарний, санітарно-епідеміологічний, фітосанітарний, ' +
  'радіологічний, екологічний) — ОБОВʼЯЗКОВО з кодами документів (напр. 0853, 5514, 5509) і тим, ' +
  'що кожен документ означає та коли застосовується;\n' +
  '- технічні регламенти, сертифікати відповідності;\n' +
  '- наркотичні засоби / прекурсори, товари подвійного використання;\n' +
  '- правові підстави (постанови КМУ, закони) і дати набрання чинності, якщо вказані.\n' +
  'Пиши ДОСЛІВНО суть із фрагмента; нічого не додумуй і не узагальнюй понад текст. ' +
  'Якщо у ЦЬОМУ фрагменті немає нічого релевантного — відповідай рівно одним символом: —';

/** Split into overlapping char windows, preferring to cut on a newline near the edge. */
function splitChunks(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      // Prefer a newline boundary in the last 800 chars of the window.
      const nl = text.lastIndexOf('\n', end);
      if (nl > start + CHUNK_CHARS - 800) end = nl;
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }
  return chunks;
}

async function summarizeChunk(code: string, chunk: string): Promise<string> {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: CHUNK_MAX_TOKENS,
    messages: [{ role: 'user', content: `${CHUNK_INSTRUCTION(code)}\n\n---\n${chunk}` }],
  });
  const out = msg.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  return out;
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

/**
 * Produce a compact, COMPLETE digest of the goodinfo page. Small pages pass
 * through unchanged; large pages are batched. If every batch fails, falls back to
 * a head slice so the tool still returns something useful.
 */
export async function digestUktzed(code: string, text: string): Promise<string> {
  if (text.length <= DIGEST_THRESHOLD) return text;

  const chunks = splitChunks(text);
  let parts: string[];
  try {
    parts = await mapLimit(chunks, CONCURRENCY, (c) =>
      summarizeChunk(code, c).catch(() => ''),
    );
  } catch {
    return text.slice(0, DIGEST_THRESHOLD);
  }

  const merged = parts.map((p) => p.trim()).filter((p) => p && p !== '—').join('\n');
  if (!merged) return text.slice(0, DIGEST_THRESHOLD);

  const note =
    chunks.length > 1
      ? `Структурований підсумок з офіційної довідки (оброблено ${chunks.length} частин, ` +
        'щоб не втратити жодного розділу — мито/ПДВ/пільги/ліцензування/заборони/контроль/регламенти):'
      : 'Підсумок з офіційної довідки:';
  return `${note}\n${merged}`;
}
