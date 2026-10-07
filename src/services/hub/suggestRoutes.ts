import { anthropic, MODEL } from '../../anthropic/client.js';
import { runWithAnthropicLimit } from '../../anthropic/limiter.js';
import { query } from '../../db/pool.js';
import { getCarrier } from './carriers.js';
import { listCarriers, referenceLanes, RED_SEA_UK, UA_STATUS_UK } from './lines.js';
import { estimateLegDays, legGeometry, type RouteMode } from './plan.js';
import { matchPlace, placeByCode, PLACES, type Place } from './places.js';
import { listPorts } from './ports.js';
import type { LegBody } from './routePlans.js';

/**
 * Штурман route suggestions (hub phase 4). Claude gets ONLY the hub's own facts
 * — live port / crossing statuses, carrier statuses (Ukraine bookings, Suez vs
 * Cape), the team's services, distance-based corridor transits and war-risk
 * notes — and proposes 2–3 multimodal variants through a strict tool. The server
 * then validates every place code against the gazetteer, rebuilds geometry and
 * re-estimates each leg's duration itself, so the numbers shown come from our
 * maths, not the model's memory. Advisory: the UI says so.
 */

const DAY = 86_400_000;

export interface SuggestInput {
  from: string;
  to: string;
  readyDate?: string;
  cargo?: string;
  priority?: 'cost' | 'speed' | 'reliability';
}

export class SuggestError extends Error {}

export function resolvePlace(q: string): Place | undefined {
  return placeByCode(q.trim()) ?? matchPlace(q);
}

const TOOL = {
  name: 'propose_routes',
  description: 'Запропонувати 2–3 варіанти мультимодального маршруту.',
  input_schema: {
    type: 'object' as const,
    properties: {
      variants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Коротко: напр. «Море через Констанцу + авто».' },
            summary: { type: 'string', description: '1–2 речення: чому цей варіант.' },
            legs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  mode: { type: 'string', enum: ['sea', 'air', 'road', 'rail', 'customs'] },
                  from_code: { type: 'string', description: 'Код зі списку МІСЦЯ.' },
                  to_code: { type: 'string', description: 'Код зі списку МІСЦЯ (для customs = from_code).' },
                  carrier: { type: 'string', description: 'id лінії/перевізника зі списку або порожньо.' },
                  via: { type: 'string', enum: ['', 'suez', 'cape'] },
                },
                required: ['mode', 'from_code', 'to_code'],
              },
            },
            cost_level: { type: 'string', enum: ['low', 'medium', 'high'] },
            risks: { type: 'array', items: { type: 'string' } },
            pros: { type: 'array', items: { type: 'string' } },
            cons: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'summary', 'legs', 'cost_level', 'risks'],
        },
      },
    },
    required: ['variants'],
  },
};

function fmtAge(iso: string | null): string {
  if (!iso) return '';
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h < 24 ? `${h} год тому` : `${Math.round(h / 24)} дн тому`;
}

async function contextBlock(userId: string, from: Place, to: Place): Promise<string> {
  const [ports, carriers, services] = await Promise.all([
    listPorts(userId),
    listCarriers(),
    query<{ carrier: string; name: string; rotation: string[]; transit_days_min: number | null; transit_days_max: number | null; via: string }>(
      'SELECT carrier, name, rotation, transit_days_min, transit_days_max, via FROM carrier_services ORDER BY updated_at DESC LIMIT 40',
    ),
  ]);
  const keyPorts = ports.filter(
    (p) => p.kind !== 'inland' && (p.country === 'UA' || p.status || p.code === from.code || p.code === to.code || ['ROCND', 'PLGDN', 'TRAMR', 'BGVAR', 'ROGLA'].includes(p.code)),
  );
  const portLines = keyPorts.map(
    (p) => `${p.code} ${p.name}: ${p.status ? `${p.status.label}${p.status.note ? ` (${p.status.note})` : ''}, ${fmtAge(p.status.updatedAt)}` : 'немає даних'}`,
  );
  const carrierLines = carriers.map(
    (c) =>
      `${c.id} ${c.name}: Україна — ${c.uaStatus ? UA_STATUS_UK[c.uaStatus.value] : 'невідомо'}; Азія–Європа — ${c.redSea ? RED_SEA_UK[c.redSea.value] : 'невідомо'}` +
      `${c.warRisk ? `; надбавка: ${c.warRisk.value}` : ''}` +
      `${c.reliability.onTimeShare != null ? `; вчасно ${Math.round(c.reliability.onTimeShare * 100)}% (${c.reliability.delivered})` : ''}`,
  );
  const laneLines = referenceLanes().map((l) => `${l.name}: ${l.rotation.map((r) => r.code).join('→')}, ${l.transitDaysMin}–${l.transitDaysMax} дн`);
  const svcLines = services.rows.map(
    (s) => `${s.carrier} «${s.name}»: ${s.rotation.join('→')}${s.transit_days_min ? `, ${s.transit_days_min}${s.transit_days_max ? `–${s.transit_days_max}` : ''} дн` : ''}${s.via ? `, ${s.via}` : ''}`,
  );
  const places = PLACES.map((p) => `${p.code} ${p.name} (${p.kind}, ${p.country})`).join('; ');
  return [
    'СТАТУСИ ПОРТІВ І ПУНКТІВ ПРОПУСКУ (команда + ШІ з новин):',
    ...portLines,
    '',
    'МОРСЬКІ ЛІНІЇ:',
    ...carrierLines,
    '',
    'КОРИДОРИ (транзит розраховано за відстанню):',
    ...laneLines,
    '',
    'СЕРВІСИ КОМАНДИ:',
    ...(svcLines.length ? svcLines : ['(немає)']),
    '',
    'ЗОНИ ВОЄННОГО РИЗИКУ: Червоне море/Аденська затока (атаки, обхід Африки +10–14 діб), північ Чорного моря (страхові надбавки), Перська затока.',
    '',
    `МІСЦЯ (дозволені коди): ${places}`,
  ].join('\n');
}

export async function suggestRoutes(userId: string, input: SuggestInput) {
  const from = resolvePlace(input.from);
  const to = resolvePlace(input.to);
  if (!from) throw new SuggestError(`Не знайшов «${input.from}» у довіднику — оберіть порт, аеропорт чи місто зі списку.`);
  if (!to) throw new SuggestError(`Не знайшов «${input.to}» у довіднику — оберіть порт, аеропорт чи місто зі списку.`);
  const ready = input.readyDate ? new Date(input.readyDate) : new Date();
  const ctx = await contextBlock(userId, from, to);
  const prio = { cost: 'найнижча вартість', speed: 'найшвидше', reliability: 'найнадійніше / найменше ризиків' }[input.priority ?? 'reliability'];
  const prompt =
    `Ти — Штурман, логіст імпорту в Україну. Запропонуй 2–3 РІЗНІ реалістичні варіанти доставки ` +
    `з ${from.code} (${from.name}) до ${to.code} (${to.name}). Готовність вантажу: ${ready.toISOString().slice(0, 10)}. ` +
    `Вантаж: ${input.cargo?.trim() || 'не вказано (за замовчуванням — хімічна/фарм субстанція, генеральний вантаж)'}. Пріоритет: ${prio}.\n` +
    'Правила: використовуй ЛИШЕ коди з МІСЦЬ і лише факти з даних нижче. Якщо порт/кордон «немає даних» — не стверджуй, що він ' +
    'працює, а внеси це в risks. Якщо лінія «Не приймає на Україну» — не пропонуй її до українського порту. Мультимодальність: ' +
    'море/авіа + авто/залізниця + митне оформлення (customs-плече в пункті пропуску чи на митниці призначення). ' +
    'Для моря вкажи via (suez/cape) з урахуванням статусу ліній. Не вигадуй цін і точних дат — лише cost_level.\n\n' +
    ctx;

  let block: { input: unknown } | null = null;
  for (let attempt = 0; attempt < 2 && !block; attempt += 1) {
    const msg = await runWithAnthropicLimit(() =>
      anthropic.messages.create({
        model: MODEL,
        max_tokens: 8000,
        output_config: { effort: 'medium' },
        tools: [TOOL],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: prompt }],
      }),
    );
    const b = msg.content.find((x) => x.type === 'tool_use');
    if (b && b.type === 'tool_use') block = b;
    if (msg.stop_reason === 'refusal') break;
  }
  const raw = (block?.input as { variants?: unknown[] } | undefined)?.variants ?? [];

  const variants = [];
  for (const v of raw.slice(0, 3) as Array<Record<string, unknown>>) {
    const legsIn = Array.isArray(v.legs) ? (v.legs as Array<Record<string, unknown>>) : [];
    const legs: (LegBody & { estimatedDays: number; fromName: string; toName: string; carrierName: string })[] = [];
    let cursor = ready.getTime();
    let valid = legsIn.length > 0;
    for (const l of legsIn) {
      const mode = String(l.mode) as RouteMode;
      const a = placeByCode(String(l.from_code ?? ''));
      const b = placeByCode(String(l.to_code ?? '')) ?? (mode === 'customs' ? a : undefined);
      if (!a || !b || !['sea', 'air', 'road', 'rail', 'customs'].includes(mode)) {
        valid = false;
        break;
      }
      const via = mode === 'sea' && ['suez', 'cape'].includes(String(l.via)) ? (String(l.via) as 'suez' | 'cape') : '';
      const carrier = l.carrier && getCarrier(String(l.carrier)) ? String(l.carrier) : '';
      const path = legGeometry({
        mode,
        from: { code: a.code, name: a.name, pos: [a.lat, a.lng] },
        to: { code: b.code, name: b.name, pos: [b.lat, b.lng] },
        via,
      });
      const days = estimateLegDays(mode, path);
      const dep = cursor;
      const arr = cursor + days * DAY;
      cursor = arr;
      legs.push({
        mode,
        from: { code: a.code },
        to: { code: b.code },
        carrier,
        via,
        plannedDeparture: new Date(dep).toISOString(),
        plannedArrival: new Date(arr).toISOString(),
        estimatedDays: days,
        fromName: a.name,
        toName: b.name,
        carrierName: carrier ? (getCarrier(carrier)?.name ?? carrier) : '',
      });
    }
    if (!valid) continue;
    const strs = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, 6) : []);
    variants.push({
      title: String(v.title ?? 'Варіант'),
      summary: String(v.summary ?? ''),
      costLevel: ['low', 'medium', 'high'].includes(String(v.cost_level)) ? String(v.cost_level) : 'medium',
      risks: strs(v.risks),
      pros: strs(v.pros),
      cons: strs(v.cons),
      totalDays: Math.round((cursor - ready.getTime()) / DAY),
      arrival: new Date(cursor).toISOString(),
      legs,
    });
  }
  return { from: { code: from.code, name: from.name }, to: { code: to.code, name: to.name }, readyDate: ready.toISOString(), variants };
}
