import type { ChatTool } from '../anthropic/client.js';
import { query } from '../db/pool.js';
import { attentionRows, calendarRange, CARGO_LABEL, type CalendarEvent, type CalendarRow } from '../services/sheet/calendar.js';
import { kyivToday, sheetEnabled, sheetRowUrl } from '../services/sheet/sync.js';

/**
 * Chat + public-MCP tools over the team Google Sheet (synced hourly):
 *
 *   sheet_shipments    what departs / arrives in a period, or where a product /
 *                      number is — plan from the sheet + what tracking says
 *   warehouse_intake   planned intake to the БЦ warehouse (Аркуш5)
 *   sheet_reference    reference tabs: Черноморськ vs Гданськ costs, quantities
 *
 * Data is the sheet's, as last synced — every answer names the sync time and
 * marks guessed years / approximate dates with "≈". No data → says so.
 */

export const sheetToolDefinitions: ChatTool[] = [
  {
    name: 'sheet_shipments',
    description:
      'Робоча таблиця логістів (Google Sheet, оновлюється щогодини): що виходить / прибуває за період і де зараз ' +
      'конкретний вантаж. Повертає план з таблиці (вихід, плановe прибуття, статус «в дорозі / прибуло / розмитнено / ' +
      'доставлено», хто везе, логіст, рядок таблиці) і що каже трекінг (17TRACK / Нова Пошта / розрахунок). ' +
      'Для «що приходить цього тижня» — period=week; для «де Холіна хлорид» — query. Дати з «≈» — орієнтовні (розрахунок).',
    input_schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'tomorrow', 'week', 'next_week', 'month', 'next_month', 'custom'],
          description: 'Період подій. За замовчуванням week (поточний тиждень).',
        },
        from: { type: 'string', description: 'Для period=custom: початок YYYY-MM-DD.' },
        to: { type: 'string', description: 'Для period=custom: кінець YYYY-MM-DD.' },
        query: { type: 'string', description: 'Пошук за товаром, номером контейнера / ТТН, перевізником або місцем.' },
        logist: { type: 'string', description: 'Лише вантажі цього логіста (імʼя як у таблиці: «Люда», «Яна»).' },
        attention: { type: 'boolean', description: 'true — список проблемних рядків (план минув, немає дат, зіпсований номер).' },
      },
    },
  },
  {
    name: 'warehouse_intake',
    description:
      'Плановий заїзд на склад БЦ з таблиці (аркуш «Аркуш5»): товар, кількість, коли (текстом, тому дата орієнтовна), ' +
      'чи влазить у склад, примітки (доставка в Харків тощо).',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Фільтр за товаром.' } } },
  },
  {
    name: 'sheet_reference',
    description:
      'Довідкові аркуші робочої таблиці: tab=rates — порівняння вартості доставки Черноморськ / Гданськ (море, порт, ' +
      'авто…); tab=quantities — кількості за номенклатурою. Повертає таблицю як є; query — фільтр рядків.',
    input_schema: {
      type: 'object',
      properties: {
        tab: { type: 'string', enum: ['rates', 'quantities'] },
        query: { type: 'string', description: 'Фільтр рядків (назва товару / статті витрат).' },
      },
      required: ['tab'],
    },
  },
];

const SHEET_NAMES = new Set(sheetToolDefinitions.map((t) => (t as { name: string }).name));
export function isSheetTool(name: string): boolean {
  return SHEET_NAMES.has(name);
}

/** The sheet tools when a sheet is connected, else none. */
export function sheetTools(): ChatTool[] {
  return sheetEnabled() ? sheetToolDefinitions : [];
}

const DAY = 86_400_000;
const add = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

export function periodRange(period: string, today: string, from?: string, to?: string): [string, string] {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = add(today, -dow);
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const monthStart = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const monthEnd = (yy: number, mm: number) => add(mm === 12 ? monthStart(yy + 1, 1) : monthStart(yy, mm + 1), -1);
  switch (period) {
    case 'today':
      return [today, today];
    case 'tomorrow':
      return [add(today, 1), add(today, 1)];
    case 'next_week':
      return [add(monday, 7), add(monday, 13)];
    case 'month':
      return [monthStart(y, m), monthEnd(y, m)];
    case 'next_month':
      return m === 12 ? [monthStart(y + 1, 1), monthEnd(y + 1, 1)] : [monthStart(y, m + 1), monthEnd(y, m + 1)];
    case 'custom':
      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from) && to && /^\d{4}-\d{2}-\d{2}$/.test(to)) return [from, to];
      return [monday, add(monday, 6)];
    default:
      return [monday, add(monday, 6)];
  }
}

const EV_LABEL: Record<CalendarEvent['type'], string> = {
  departure: 'вихід',
  arrival: 'прибуття (план)',
  arrived: 'прибуло',
  customs: 'розмитнено',
  delivered: 'доставлено',
  eta: 'ETA трекінгу',
  warehouse: 'заїзд на склад БЦ',
  free_end: 'кінець безкоштовного зберігання',
};

function rowLine(r: CalendarRow): string {
  const parts = [
    `**${r.product}**`,
    r.tab === 'tracking' ? CARGO_LABEL[r.cargoType] : '',
    r.number ? `№ ${r.number}${r.carrierName ? ` (${r.carrierName})` : ''}${r.trackLink ? ` — трекінг: ${r.trackLink}` : ''}` : '',
    r.origin || r.destination ? `${r.origin || '—'} → ${r.destination || '—'}` : '',
    r.departure ? `вихід ${dmy(r.departure.date)}` : '',
    r.arrival ? `план ${dmy(r.arrival.date)}` : '',
    `статус: ${r.statusLabel}${r.statusDate ? ` ${dmy(r.statusDate.date)}` : ''}`,
    r.track ? `трекінг: ${r.track.statusLabel}${r.track.eta ? `, ETA ${dmy(r.track.eta.slice(0, 10))}` : ''}` : '',
    r.forwarder ? `везе: ${r.forwarder}` : '',
    r.logist ? `логіст: ${r.logist}` : '',
    r.comment ? `коментар: ${r.comment.replace(/\s+/g, ' ').slice(0, 140)}` : '',
    `рядок ${r.rowIndex}`,
  ];
  return `- ${parts.filter(Boolean).join(' · ')}`;
}

async function lastSync(): Promise<string> {
  const { rows } = await query<{ synced_at: string | null; ok: boolean; error: string }>(
    `SELECT synced_at, ok, error FROM sheet_tabs WHERE tab = 'tracking'`,
  );
  const r = rows[0];
  if (!r?.synced_at) return 'Таблицю ще не синхронізовано.';
  const at = new Date(r.synced_at).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Kyiv' });
  return r.ok ? `Джерело: робоча таблиця, синхронізовано ${at}.` : `Остання спроба синхронізації ${at} невдала: ${r.error}.`;
}

function matches(r: CalendarRow, q: string): boolean {
  const f = fold(q);
  return [r.product, r.number ?? '', r.carrierName ?? '', r.forwarder, r.origin, r.destination, r.comment].some((x) => fold(x).includes(f));
}

async function runShipments(input: Record<string, unknown>): Promise<{ result: string; summary: string }> {
  const today = kyivToday();
  const q = typeof input.query === 'string' ? input.query.trim() : '';
  const logist = typeof input.logist === 'string' ? fold(input.logist.trim()) : '';
  const byLogist = (r: CalendarRow) => !logist || fold(r.logist).startsWith(logist.slice(0, 3));

  if (input.attention === true) {
    const rows = (await attentionRows()).filter(byLogist);
    if (!rows.length) return { result: `Проблемних рядків немає. ${await lastSync()}`, summary: 'Таблиця: проблем немає' };
    const lines = rows.slice(0, 40).map((r) => `${rowLine(r)}\n  ⚠ ${r.issues.map((i) => i.label).join('; ')}`);
    return { result: `Потребують уваги (${rows.length}):\n${lines.join('\n')}\n${await lastSync()}`, summary: `Таблиця: ${rows.length} проблемних рядків` };
  }

  if (q) {
    // Search across the whole history (a year back, half a year ahead).
    const { rows } = await calendarRange(add(today, -365), add(today, 183));
    const hits = rows.filter((r) => r.tab === 'tracking' && matches(r, q) && byLogist(r)).sort((a, b) => b.rowIndex - a.rowIndex);
    if (!hits.length) return { result: `У таблиці не знайдено «${q}». ${await lastSync()}`, summary: 'Таблиця: не знайдено' };
    return {
      result: `Знайдено в таблиці (${hits.length}, спершу найновіші):\n${hits.slice(0, 15).map(rowLine).join('\n')}\n${await lastSync()}`,
      summary: `Таблиця: ${hits.length} збіг(ів) «${q}»`,
    };
  }

  const [from, to] = periodRange(String(input.period ?? 'week'), today, input.from as string, input.to as string);
  const p = await calendarRange(from, to);
  const byId = new Map(p.rows.map((r) => [r.id, r]));
  const events = p.events.filter((e) => {
    const r = byId.get(e.rowId);
    return r && byLogist(r);
  });
  if (!events.length) {
    return { result: `За ${dmy(from)}–${dmy(to)} у таблиці подій немає. ${await lastSync()}`, summary: 'Таблиця: подій немає' };
  }
  const lines = events.map((e) => {
    const r = byId.get(e.rowId)!;
    return `${dmy(e.date)}${e.approx ? '≈' : ''} — ${EV_LABEL[e.type]}${e.source ? ` (${e.source})` : ''}:\n  ${rowLine(r).slice(2)}`;
  });
  return {
    result: `Події ${dmy(from)}–${dmy(to)} (${events.length}):\n${lines.join('\n')}\n${await lastSync()}`,
    summary: `Таблиця: ${events.length} подій ${dmy(from)}–${dmy(to)}`,
  };
}

async function runWarehouse(input: Record<string, unknown>): Promise<{ result: string; summary: string }> {
  const q = typeof input.query === 'string' ? fold(input.query.trim()) : '';
  const { rows } = await query<{ row_index: number; data: { product: string; qty: string; when: string; fits: string; note: string; approx: { date: string } | null } }>(
    `SELECT row_index, data FROM sheet_rows WHERE tab = 'warehouse' AND NOT removed ORDER BY row_index`,
  );
  const list = rows.filter((r) => !q || fold(r.data.product).includes(q));
  if (!list.length) return { result: `Планових заїздів на склад БЦ у таблиці немає${q ? ` для «${q}»` : ''}. ${await lastSync()}`, summary: 'Склад БЦ: немає' };
  const lines = list.map((r) => {
    const d = r.data;
    return `- **${d.product}** · ${d.qty || '—'} · коли: ${d.when || '—'}${d.approx ? ` (≈ ${dmy(d.approx.date)})` : ''} · в БЦ: ${d.fits || '—'}${d.note ? ` · ${d.note}` : ''} · рядок ${r.row_index}`;
  });
  return { result: `Плановий заїзд на склад БЦ:\n${lines.join('\n')}\n${await lastSync()}`, summary: `Склад БЦ: ${list.length} позицій` };
}

async function runReference(input: Record<string, unknown>): Promise<{ result: string; summary: string }> {
  const tab = input.tab === 'quantities' ? 'quantities' : 'rates';
  const q = typeof input.query === 'string' ? fold(input.query.trim()) : '';
  const { rows } = await query<{ grid: string[][] | null; synced_at: string | null }>('SELECT grid, synced_at FROM sheet_tabs WHERE tab = $1', [tab]);
  const grid = rows[0]?.grid ?? [];
  if (!grid.length) return { result: 'Довідкового аркуша ще немає (таблицю не синхронізовано).', summary: 'Таблиця: немає даних' };
  const head = grid.slice(0, 2);
  const body = grid.slice(2).filter((r) => !q || r.some((c) => fold(c).includes(q)));
  const md = [...head, ...body.slice(0, 80)].map((r) => `| ${r.map((c) => c.replace(/\|/g, '/').replace(/\s+/g, ' ')).join(' | ')} |`);
  const title = tab === 'rates' ? 'Порівняння вартості Черноморськ / Гданськ' : 'Кількості за номенклатурою';
  const link = sheetRowUrl(tab);
  return {
    result: `${title} (аркуш таблиці${link ? `: ${link}` : ''}):\n${md.join('\n')}\n${await lastSync()}`,
    summary: `Таблиця: ${title}`,
  };
}

export async function executeSheetTool(name: string, input: unknown): Promise<{ result: string; summary: string }> {
  if (!sheetEnabled()) return { result: 'Робочу таблицю не підключено.', summary: 'Таблиця: не підключено' };
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'sheet_shipments':
      return runShipments(args);
    case 'warehouse_intake':
      return runWarehouse(args);
    case 'sheet_reference':
      return runReference(args);
    default:
      return { result: `Невідомий інструмент: ${name}`, summary: 'Таблиця: помилка' };
  }
}
