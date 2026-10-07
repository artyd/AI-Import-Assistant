import type { ChatTool } from '../anthropic/client.js';
import { getCarrier } from '../services/hub/carriers.js';
import { trackingSuggestions } from '../services/hub/suggest.js';
import {
  addTracked,
  HubError,
  listEvents,
  listTracked,
  lookupNumber,
  serializeTracked,
  type TrackedDto,
  type TrackingEventRow,
} from '../services/hub/track.js';
import { STATUS_LABEL_UK, type TrackResult } from '../services/hub/types.js';

/**
 * Logistics-hub tools for the Штурман agent (chat) and the public MCP server.
 *
 *  - track_shipment            persist a number in the user's hub (+ link to the
 *                              current shipment) and report its live status
 *  - list_tracked_shipments    what the user is tracking (shipment-scoped in a
 *                              shipment chat)
 *  - find_tracking_numbers     numbers in this shipment's documents not yet tracked
 *  - track_by_number           read-only lookup, nothing stored (public MCP)
 *
 * Every result states its source and freshness; "no data" is said plainly.
 */

export interface HubToolContext {
  workspaceId?: string;
  ownerId?: string;
}

export interface HubToolOutcome {
  result: string;
  summary: string;
}

const NUMBER_PROP = {
  type: 'string',
  description: 'Номер контейнера (MSKU1234565), коносамента (B/L), AWB (157-12345675), курʼєрської накладної або ТТН Нової Пошти.',
};
const CARRIER_PROP = {
  type: 'string',
  description: 'Необовʼязково: id перевізника, якщо номер неоднозначний (maersk, msc, cma, cosco, hapag, one, dhl, fedex, ups, novaposhta, ukrposhta…).',
};

export const hubToolDefinitions: ChatTool[] = [
  {
    name: 'track_shipment',
    description:
      'Додати номер у Логістичний хаб користувача (карта + автооновлення статусу) і одразу отримати поточний статус, ' +
      'події, ETA та джерело даних. У чаті постачання номер привʼязується до цього постачання. ' +
      'Використовуй, коли користувач просить відстежити вантаж або питає «де мій контейнер/посилка».',
    input_schema: {
      type: 'object',
      properties: {
        number: NUMBER_PROP,
        carrier: CARRIER_PROP,
        label: { type: 'string', description: 'Необовʼязкова коротка назва (напр. «Метопрен, партія 2»).' },
      },
      required: ['number'],
    },
  },
  {
    name: 'list_tracked_shipments',
    description:
      'Список вантажів, які користувач відстежує в Логістичному хабі (у чаті постачання — лише привʼязані до нього): ' +
      'статус, ETA, джерело і час останньої перевірки.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_tracking_numbers',
    description:
      'Знайти в документах ЦЬОГО постачання номери контейнерів / AWB / коносаментів, які ще не відстежуються. ' +
      'Повертає лише перевірені номери (контрольна цифра / префікс перевізника). Запропонуй користувачу їх відстежувати.',
    input_schema: { type: 'object', properties: {} },
  },
];

export const publicTrackTool: ChatTool = {
  name: 'track_by_number',
  description:
    'Відстеження вантажу за номером (контейнер, B/L, AWB, курʼєр, Нова Пошта/Укрпошта) без збереження: ' +
    'визначає перевізника, бере статус з офіційного API або публічної сторінки перевізника, повертає події та ETA. ' +
    'Якщо даних немає — так і каже та дає посилання на сторінку перевізника.',
  input_schema: {
    type: 'object',
    properties: { number: NUMBER_PROP, carrier: CARRIER_PROP },
    required: ['number'],
  },
};

const HUB_NAMES = new Set(['track_shipment', 'list_tracked_shipments', 'find_tracking_numbers', 'track_by_number']);
export function isHubTool(name: string): boolean {
  return HUB_NAMES.has(name);
}

const d = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Kyiv' }) : '—';

function sourceLine(source: string, checkedAt: string | null): string {
  const s = source.startsWith('api:')
    ? `офіційний API (${source.slice(4)})`
    : source.startsWith('scrape:')
      ? `публічна сторінка перевізника (${source.slice(7)})`
      : 'немає';
  return `Джерело: ${s}; перевірено: ${d(checkedAt)}.`;
}

function eventsBlock(events: Array<Pick<TrackingEventRow, 'at' | 'location' | 'description' | 'planned'>>): string {
  if (events.length === 0) return 'Подій немає.';
  return events
    .slice(-12)
    .map((e) => `- ${d(e.at)} · ${e.location || '—'} · ${e.description}${e.planned ? ' (план)' : ''}`)
    .join('\n');
}

function trackedText(t: TrackedDto, events: TrackingEventRow[]): string {
  const lines = [
    `${t.label ? `${t.label} — ` : ''}${t.number} (${t.carrierName}, ${t.kind})`,
    `Статус: ${t.statusLabel}${t.statusText ? ` — «${t.statusText}»` : ''}`,
    `Маршрут: ${t.origin || '—'} → ${t.destination || '—'}`,
  ];
  if (t.vesselName) lines.push(`Судно: ${t.vesselName}${t.vesselImo ? ` (IMO ${t.vesselImo})` : ''}`);
  lines.push(`ETA: ${d(t.eta)}${t.firstEta && t.eta && t.firstEta !== t.eta ? ` (спершу була ${d(t.firstEta)})` : ''}`);
  if (t.workspaceNumber) lines.push(`Постачання: ${t.workspaceNumber}`);
  lines.push(sourceLine(t.source, t.lastCheckedAt));
  if (t.status === 'unknown' || t.source === 'none') {
    lines.push(`Даних від перевізника немає${t.lastError ? ` (${t.lastError})` : ''}. Перевірити вручну: ${t.trackUrl ?? '—'}`);
  } else if (t.trackUrl) {
    lines.push(`Сторінка перевізника: ${t.trackUrl}`);
  }
  lines.push('Події:', eventsBlock(events));
  return lines.join('\n');
}

function lookupText(o: { number: string; carrierName: string; kind: string; trackUrl: string | null; result: TrackResult }): string {
  const r = o.result;
  if (!r.found) {
    return (
      `${o.number} (${o.carrierName}, ${o.kind}): даних немає. ${r.note ?? ''}\n` +
      `Перевірити вручну: ${o.trackUrl ?? '—'}`
    );
  }
  return [
    `${o.number} (${o.carrierName}, ${o.kind})`,
    `Статус: ${STATUS_LABEL_UK[r.status]}${r.statusText ? ` — «${r.statusText}»` : ''}`,
    `Маршрут: ${r.origin || '—'} → ${r.destination || '—'}`,
    r.vesselName ? `Судно: ${r.vesselName}` : '',
    `ETA: ${d(r.eta)}`,
    sourceLine(r.source, new Date().toISOString()),
    o.trackUrl ? `Сторінка перевізника: ${o.trackUrl}` : '',
    'Події:',
    eventsBlock(r.events.map((e) => ({ ...e, planned: !!e.planned }))),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function executeHubTool(name: string, input: unknown, ctx: HubToolContext): Promise<HubToolOutcome> {
  const args = (input ?? {}) as { number?: unknown; carrier?: unknown; label?: unknown };
  const number = String(args.number ?? '').trim();
  const carrier = args.carrier ? String(args.carrier).trim() : undefined;
  if (carrier && !getCarrier(carrier)) {
    return { result: `Невідомий перевізник «${carrier}».`, summary: 'Хаб: помилка' };
  }

  switch (name) {
    case 'track_by_number': {
      if (!number) return { result: 'Не вказано номер.', summary: 'Трекінг: помилка' };
      const o = await lookupNumber(number, carrier);
      if (!o) {
        return {
          result: `Не вдалося визначити перевізника для «${number}». Уточніть перевізника (параметр carrier).`,
          summary: 'Трекінг: перевізника не визначено',
        };
      }
      return { result: lookupText(o), summary: `Трекінг ${o.number}: ${o.result.found ? STATUS_LABEL_UK[o.result.status] : 'немає даних'}` };
    }
    case 'track_shipment': {
      if (!ctx.ownerId) return { result: 'Хаб недоступний у цьому контексті.', summary: 'Хаб: помилка' };
      if (!number) return { result: 'Не вказано номер.', summary: 'Хаб: помилка' };
      try {
        const row = await addTracked(ctx.ownerId, {
          number,
          carrier,
          label: args.label ? String(args.label) : undefined,
          workspaceId: ctx.workspaceId ?? null,
        });
        const t = serializeTracked(row);
        return {
          result: `Додано в Логістичний хаб (оновлюється автоматично, видно на карті).\n${trackedText(t, await listEvents(row.id))}`,
          summary: `Хаб: ${t.number} — ${t.statusLabel}`,
        };
      } catch (err) {
        if (err instanceof HubError) return { result: err.message, summary: 'Хаб: помилка' };
        throw err;
      }
    }
    case 'list_tracked_shipments': {
      if (!ctx.ownerId) return { result: 'Хаб недоступний у цьому контексті.', summary: 'Хаб: помилка' };
      const rows = await listTracked(ctx.ownerId, { workspaceId: ctx.workspaceId });
      if (rows.length === 0) {
        return {
          result: ctx.workspaceId ? 'До цього постачання не привʼязано жодного трек-номера.' : 'У хабі немає відстежуваних вантажів.',
          summary: 'Хаб: порожньо',
        };
      }
      const text = rows
        .map(serializeTracked)
        .map(
          (t) =>
            `- ${t.label ? `${t.label} — ` : ''}${t.number} (${t.carrierName}): ${t.statusLabel}; ` +
            `${t.origin || '—'} → ${t.destination || '—'}; ETA ${d(t.eta)}; ${sourceLine(t.source, t.lastCheckedAt)}`,
        )
        .join('\n');
      return { result: text, summary: `Хаб: ${rows.length} вантаж(ів)` };
    }
    case 'find_tracking_numbers': {
      if (!ctx.ownerId || !ctx.workspaceId) {
        return { result: 'Пошук номерів працює лише в чаті постачання.', summary: 'Хаб: помилка' };
      }
      const list = await trackingSuggestions(ctx.ownerId, ctx.workspaceId);
      if (list.length === 0) {
        return { result: 'У документах постачання не знайдено нових номерів для відстеження.', summary: 'Хаб: номерів не знайдено' };
      }
      return {
        result:
          'Знайдено номери (ще не відстежуються):\n' +
          list.map((s) => `- ${s.number} — ${s.carrierName} (${s.kind}); файли: ${s.files.join(', ')}`).join('\n'),
        summary: `Хаб: знайдено ${list.length} номер(ів)`,
      };
    }
    default:
      return { result: `Невідомий інструмент: ${name}`, summary: 'Невідомий інструмент' };
  }
}
