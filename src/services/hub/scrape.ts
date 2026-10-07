import { createHash } from 'node:crypto';
import { anthropic } from '../../anthropic/client.js';
import { runWithAnthropicLimit } from '../../anthropic/limiter.js';
import { config } from '../../config.js';
import * as logist from '../logist/index.js';
import { renderPageText } from '../pdf.js';
import { CARRIERS, getCarrier, trackingUrl } from './carriers.js';
import { TRACK_STATUSES, toIso, type TrackResult, type TrackStatus } from './types.js';

/**
 * Tier 2 of the hybrid tracker: read the carrier's PUBLIC tracking page.
 *
 *   1. logist-mcp fetches the page and returns its readable text (our MCP
 *      service — allow-listed carrier hosts only);
 *   2. if that is an empty SPA shell, headless Chromium renders it;
 *   3. Claude (TRACKING_PARSE_MODEL, Haiku by default) reads the milestones out
 *      of the text into a strict tool schema — it may only copy what the page
 *      says, never infer.
 *
 * If the page doesn't even contain the number (blocked / captcha / not found)
 * the result is `found:false` with a note — the UI then shows "немає даних" plus
 * the carrier link, never a made-up status.
 */

const ALLOWED_HOSTS = new Set(
  CARRIERS.flatMap((c) => {
    try {
      return c.trackUrl ? [new URL(c.trackUrl.replace('{n}', 'x')).hostname] : [];
    } catch {
      return [];
    }
  }).concat(['www.track-trace.com']),
);

export function scrapeAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

const TOOL = {
  name: 'record_tracking',
  description: 'Записати дані відстеження, знайдені на сторінці перевізника.',
  input_schema: {
    type: 'object' as const,
    properties: {
      found: {
        type: 'boolean',
        description: 'true лише якщо на сторінці є дані саме по цьому номеру (а не форма пошуку / помилка / капча).',
      },
      status: { type: 'string', enum: [...TRACK_STATUSES] },
      status_text: { type: 'string', description: 'Поточний статус дослівно зі сторінки.' },
      origin: { type: 'string' },
      destination: { type: 'string' },
      vessel_name: { type: 'string' },
      vessel_imo: { type: 'string' },
      eta: { type: 'string', description: 'Очікувана дата прибуття ISO-8601, якщо вказана.' },
      departed_at: { type: 'string' },
      arrived_at: { type: 'string' },
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            at: { type: 'string', description: 'Дата/час ISO-8601 або порожньо.' },
            location: { type: 'string' },
            description: { type: 'string' },
            planned: { type: 'boolean', description: 'true — запланована/очікувана подія.' },
          },
          required: ['description'],
        },
      },
    },
    required: ['found', 'status'],
  },
};

const PROMPT = (number: string, carrier: string, text: string) =>
  `Нижче — текст публічної сторінки відстеження перевізника «${carrier}» для номера ${number}.\n` +
  'Виклич інструмент record_tracking. Правила:\n' +
  '- Бери ЛИШЕ те, що прямо написано на сторінці. Нічого не вигадуй і не добудовуй.\n' +
  '- Якщо сторінка не містить даних по цьому номеру (форма пошуку, помилка, капча, "not found") — found=false, status="unknown".\n' +
  '- status: info (бронювання/етикетка, ще не рушив), in_transit, at_port (прибув у порт/аеропорт/хаб), customs, ' +
  'out_for_delivery, delivered, exception (повернення/затримка/відмова).\n' +
  '- events — у хронологічному порядку, дати у ISO-8601.\n\n' +
  `<page>\n${text.slice(0, 30_000)}\n</page>`;

type Obj = Record<string, unknown>;
const s = (v: unknown) => (v == null ? '' : String(v)).trim();

async function pageText(url: string): Promise<string> {
  let text = '';
  if (logist.logistEnabled()) {
    try {
      text = (await logist.trackPage(url)).text ?? '';
    } catch {
      text = '';
    }
  }
  if (text.replace(/\s+/g, ' ').length < 600) {
    try {
      const rendered = await renderPageText(url);
      if (rendered.length > text.length) text = rendered;
    } catch {
      /* Chromium unavailable — keep whatever we have */
    }
  }
  return text;
}

export async function scrapeTracking(
  number: string,
  carrierId: string,
  prevHash = '',
): Promise<TrackResult | null> {
  if (!config.TRACKING_SCRAPE_ENABLED) return null;
  const url = trackingUrl(carrierId, number);
  if (!url || !scrapeAllowed(url)) return null;
  const source = `scrape:${carrierId}`;

  const text = await pageText(url);
  const compact = text.replace(/\s+/g, '').toUpperCase();
  if (!compact.includes(number.toUpperCase().replace(/\s+/g, '').slice(-8))) {
    return {
      found: false,
      status: 'unknown',
      statusText: '',
      events: [],
      source,
      note: 'Сторінка перевізника не показала дані по номеру (обмеження доступу або номер не знайдено).',
    };
  }
  const pageHash = createHash('sha256').update(text).digest('hex').slice(0, 32);
  if (pageHash === prevHash) return { found: true, status: 'pending', statusText: '', events: [], source, pageHash, note: 'unchanged' };

  const carrier = getCarrier(carrierId)?.name ?? carrierId;
  const msg = await runWithAnthropicLimit(() =>
    anthropic.messages.create({
      model: config.TRACKING_PARSE_MODEL,
      max_tokens: 4000,
      tools: [TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: PROMPT(number, carrier, text) }],
    }),
  );
  const block = msg.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') return null;
  const r = block.input as Obj;
  const status = (TRACK_STATUSES as readonly string[]).includes(s(r.status)) ? (s(r.status) as TrackStatus) : 'unknown';
  const events = (Array.isArray(r.events) ? r.events : []).map((e) => {
    const o = (e ?? {}) as Obj;
    return { at: toIso(o.at), location: s(o.location), description: s(o.description), planned: o.planned === true };
  });
  const found = r.found === true;
  return {
    found,
    status: found ? status : 'unknown',
    statusText: s(r.status_text),
    events: found ? events.filter((e) => e.description) : [],
    origin: s(r.origin),
    destination: s(r.destination),
    vesselName: s(r.vessel_name),
    vesselImo: s(r.vessel_imo).replace(/\D/g, ''),
    eta: toIso(r.eta),
    departedAt: toIso(r.departed_at),
    arrivedAt: toIso(r.arrived_at),
    source,
    pageHash,
  };
}
