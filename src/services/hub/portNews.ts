import { anthropic } from '../../anthropic/client.js';
import { runWithAnthropicLimit } from '../../anthropic/limiter.js';
import { config } from '../../config.js';
import { query } from '../../db/pool.js';
import { PLACES, type Place } from './places.js';
import { addMark, PORT_STATUSES, type PortStatus } from './ports.js';
import { addCarrierMark, type RedSea, type UaStatus } from './lines.js';

/**
 * AI hub-status reader (ports AND ocean carriers).
 *
 * Ports: After each news ingest the worker passes fresh,
 * not-yet-read news items that MENTION a known port / airport / border crossing
 * (gazetteer name or alias match — cheap, offline) to Claude, which decides per
 * mentioned place whether the item says anything about it operating:
 * ok / congested / disrupted / closed — or nothing (most news). Only explicit
 * statements become marks, each carrying the news link as its source.
 *
 * Pure matching (`placesMentioned`) is unit-tested; the model call is not.
 */

const RUBRICS = ['ports', 'freight', 'customs', 'sanctions', 'ncts', 'adr'];
const BATCH = 8;
const MIN_CONFIDENCE = 0.6;

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const NAME_KEYS: Array<{ re: RegExp; place: Place }> = PLACES.filter((p) => p.kind !== 'inland').flatMap((p) =>
  [p.name, p.nameEn, ...(p.aliases ?? [])]
    .filter((n) => n.length >= 4)
    .map((n) => {
      // Word-ish boundary that works for Cyrillic. Ukrainian names are declined
      // (Одеса → Одеси / Одесі / Одеського), so match the stem without its final
      // vowel plus a short ending.
      const cyr = /[а-яіїєґ]/i.test(n);
      const base = fold(n);
      // Short names (Рені, Поті) only match exactly — a 3-letter stem is too greedy.
      const stemmed = cyr ? base.replace(/[аяоеєиіїуюйь]$/u, '') : base;
      const declinable = cyr && stemmed.length >= 4;
      const esc = (declinable ? stemmed : base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return {
        re: new RegExp(`(^|[^\\p{L}])${esc}${declinable ? '\\p{L}{0,4}' : ''}(?=$|[^\\p{L}])`, 'u'),
        place: p,
      };
    }),
);

const CARRIER_NAMES: Array<{ id: string; re: RegExp }> = [
  ['maersk', ['maersk', 'маерськ', 'мерск', 'маерск']],
  ['msc', ['msc', 'mediterranean shipping']],
  ['cma', ['cma cgm', 'cma-cgm']],
  ['cosco', ['cosco']],
  ['oocl', ['oocl']],
  ['hapag', ['hapag-lloyd', 'hapag lloyd', 'hapag']],
  ['one', ['ocean network express']],
  ['evergreen', ['evergreen']],
  ['hmm', ['hmm', 'hyundai merchant']],
  ['yangming', ['yang ming']],
  ['zim', ['zim']],
  ['wanhai', ['wan hai']],
  ['pil', ['pacific international lines']],
  ['turkon', ['turkon']],
  ['arkas', ['arkas']],
].flatMap(([id, names]) =>
  (names as string[]).map((n) => ({
    id: id as string,
    re: new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}])`, 'u'),
  })),
);

/** Ocean carriers named in a text. */
export function carriersMentioned(text: string): string[] {
  const f = fold(text);
  return [...new Set(CARRIER_NAMES.filter((c) => c.re.test(f)).map((c) => c.id))];
}

/** Gazetteer places named in a text (ports, airports, crossings — not inland cities). */
export function placesMentioned(text: string): Place[] {
  const f = fold(text);
  const out = new Map<string, Place>();
  for (const { re, place } of NAME_KEYS) {
    if (re.test(f)) out.set(place.code, place);
  }
  return [...out.values()];
}

const TOOL = {
  name: 'record_port_statuses',
  description:
    'Записати статуси роботи портів/аеропортів/пунктів пропуску та морських ліній, прямо згадані в новинах.',
  input_schema: {
    type: 'object' as const,
    properties: {
      marks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            news: { type: 'integer', description: 'Номер новини зі списку.' },
            code: { type: 'string', description: 'Код обʼєкта зі списку кандидатів цієї новини.' },
            status: { type: 'string', enum: [...PORT_STATUSES] },
            note: { type: 'string', description: 'Коротко українською: що саме сталося (≤ 140 символів).' },
            confidence: { type: 'number', description: '0..1 — наскільки новина прямо про це говорить.' },
          },
          required: ['news', 'code', 'status', 'note', 'confidence'],
        },
      },
      carrier_marks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            news: { type: 'integer' },
            carrier: { type: 'string', description: 'id лінії зі списку кандидатів цієї новини.' },
            ua_status: {
              type: 'string',
              enum: ['accepting', 'limited', 'suspended'],
              description: 'Лише якщо новина прямо каже про прийом вантажів на Україну (Одеса/Дунай).',
            },
            red_sea: {
              type: 'string',
              enum: ['suez', 'cape', 'mixed'],
              description: 'Лише якщо новина прямо каже, як лінія ходить Азія–Європа (Суец / в обхід Африки).',
            },
            war_risk: { type: 'string', description: 'Надбавка за воєнний ризик, якщо названа (сума/умови).' },
            note: { type: 'string', description: 'Коротко українською (≤ 140 символів).' },
            confidence: { type: 'number' },
          },
          required: ['news', 'carrier', 'note', 'confidence'],
        },
      },
    },
    required: ['marks'],
  },
};

interface NewsRow {
  id: string;
  title: string | null;
  summary: string | null;
  url: string | null;
  source: string | null;
}

/** Read new news items once; returns how many marks were created. */
export async function scanNewsForHubStatus(): Promise<{ scanned: number; marks: number }> {
  const { rows } = await query<NewsRow>(
    `SELECT n.id, n.title, n.summary, n.url, n.source FROM news_items n
     WHERE n.rubric = ANY($1) AND n.published_at > now() - interval '4 days'
       AND NOT EXISTS (SELECT 1 FROM news_hub_scans s WHERE s.news_id = n.id)
     ORDER BY n.published_at DESC LIMIT 120`,
    [RUBRICS],
  );
  if (rows.length === 0) return { scanned: 0, marks: 0 };

  const candidates = rows
    .map((n) => {
      const text = `${n.title ?? ''} ${n.summary ?? ''}`;
      return { n, places: placesMentioned(text), carriers: carriersMentioned(text) };
    })
    .filter((c) => c.places.length > 0 || c.carriers.length > 0);

  let marks = 0;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const listing = batch
      .map(
        (c, k) =>
          `#${k + 1} ${c.n.title ?? ''}\n${(c.n.summary ?? '').slice(0, 900)}\n` +
          `Кандидати-обʼєкти: ${c.places.map((p) => `${p.code} (${p.name}, ${p.kind === 'air' ? 'аеропорт' : p.kind === 'customs' ? 'пункт пропуску' : 'порт'})`).join('; ') || '—'}\n` +
          `Кандидати-лінії: ${c.carriers.join(', ') || '—'}`,
      )
      .join('\n\n');
    try {
      const msg = await runWithAnthropicLimit(() =>
        anthropic.messages.create({
          model: config.TRACKING_PARSE_MODEL,
          max_tokens: 2000,
          tools: [TOOL],
          tool_choice: { type: 'auto' },
          messages: [
            {
              role: 'user',
              content:
                'Ти — аналітик логістики. Для кожної новини вирішуй ЛИШЕ щодо її кандидатів: чи новина ПРЯМО каже про ' +
                'роботу цього порту/аеропорту/пункту пропуску ЗАРАЗ. ok — працює/відновив роботу; congested — черги, ' +
                'перевантаження, затримки обробки; disrupted — часткові збої, страйк, обстріл, погода, обмеження; ' +
                'closed — закритий/зупинений. Якщо новина про інше (тарифи, статистика, плани) — НЕ додавай запис. ' +
                'Для ЛІНІЙ (carrier_marks): ua_status — лише якщо прямо сказано, чи лінія приймає вантажі на ' +
                'Україну/Одесу/Дунай; red_sea — лише якщо прямо сказано про маршрут через Суец або в обхід Африки; ' +
                'war_risk — лише назва/сума надбавки. Не вигадуй. Виклич record_port_statuses ' +
                '(marks і carrier_marks можуть бути порожніми).\n\n' +
                listing,
            },
          ],
        }),
      );
      const block = msg.content.find((b) => b.type === 'tool_use');
      const list =
        block && block.type === 'tool_use' && Array.isArray((block.input as { marks?: unknown }).marks)
          ? ((block.input as { marks: unknown[] }).marks as Array<Record<string, unknown>>)
          : [];
      for (const m of list) {
        const c = batch[Number(m.news) - 1];
        const code = String(m.code ?? '').toUpperCase();
        const status = String(m.status ?? '') as PortStatus;
        const confidence = Number(m.confidence ?? 0);
        if (!c || !c.places.some((p) => p.code === code)) continue;
        if (!PORT_STATUSES.includes(status) || confidence < MIN_CONFIDENCE) continue;
        const ok = await addMark({
          code,
          status,
          note: String(m.note ?? ''),
          source: 'ai',
          sourceUrl: c.n.url ?? '',
          sourceTitle: `${c.n.source ? `${c.n.source}: ` : ''}${c.n.title ?? ''}`,
          confidence,
        });
        if (ok) marks += 1;
      }
      const clist =
        block && block.type === 'tool_use' && Array.isArray((block.input as { carrier_marks?: unknown }).carrier_marks)
          ? ((block.input as { carrier_marks: unknown[] }).carrier_marks as Array<Record<string, unknown>>)
          : [];
      for (const m of clist) {
        const c = batch[Number(m.news) - 1];
        const carrier = String(m.carrier ?? '');
        const confidence = Number(m.confidence ?? 0);
        if (!c || !c.carriers.includes(carrier) || confidence < MIN_CONFIDENCE) continue;
        const ua = ['accepting', 'limited', 'suspended'].includes(String(m.ua_status)) ? (m.ua_status as UaStatus) : null;
        const rs = ['suez', 'cape', 'mixed'].includes(String(m.red_sea)) ? (m.red_sea as RedSea) : null;
        const wr = typeof m.war_risk === 'string' ? m.war_risk : '';
        if (!ua && !rs && !wr) continue;
        const ok = await addCarrierMark({
          carrier,
          uaStatus: ua,
          redSea: rs,
          warRisk: wr,
          note: String(m.note ?? ''),
          source: 'ai',
          sourceUrl: c.n.url ?? '',
          sourceTitle: `${c.n.source ? `${c.n.source}: ` : ''}${c.n.title ?? ''}`,
          confidence,
        });
        if (ok) marks += 1;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Hub-status news scan batch failed:', (err as Error).message);
      // Leave these unscanned so the next run retries them.
      continue;
    }
    for (const c of batch) {
      await query('INSERT INTO news_hub_scans (news_id) VALUES ($1) ON CONFLICT DO NOTHING', [c.n.id]);
    }
  }
  // Items with no gazetteer mention are done too.
  const mentioned = new Set(candidates.map((c) => c.n.id));
  for (const n of rows) {
    if (!mentioned.has(n.id)) await query('INSERT INTO news_hub_scans (news_id) VALUES ($1) ON CONFLICT DO NOTHING', [n.id]);
  }
  return { scanned: rows.length, marks };
}
