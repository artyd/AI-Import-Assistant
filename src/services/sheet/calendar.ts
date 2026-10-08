import * as XLSX from 'xlsx';
import { query } from '../../db/pool.js';
import { getCarrier } from '../hub/carriers.js';
import { liveItem } from '../hub/live.js';
import type { TrackedRow } from '../hub/track.js';
import { STATUS_LABEL_UK } from '../hub/types.js';
import { sheetRowUrl, type SheetTab } from './link.js';
import type { SheetDate, SheetIssue, SheetStatus, TrackingRow, WarehouseRow } from './parse.js';

/**
 * Logist calendar over the synced sheet rows. Every row contributes dated events:
 *
 *   departure   — "Дата выхода"
 *   arrival     — planned arrival ("Дата прибытия планируемая")
 *   arrived / customs / delivered — the date written in the status text
 *   eta         — what tracking says when it differs from the plan: the carrier /
 *                 17TRACK ETA, the actual delivery, or the route-based estimate
 *   warehouse   — planned intake to the БЦ warehouse (Аркуш5, approximate)
 *
 * Filtering (logist / mode / forwarder / place / status) is done in the browser —
 * the whole sheet is a few hundred rows.
 */

export type EventType = 'departure' | 'arrival' | 'arrived' | 'customs' | 'delivered' | 'eta' | 'warehouse';

export interface CalendarEvent {
  id: string;
  rowId: string;
  type: EventType;
  date: string;
  /** Year guessed / approximate / estimated — shown with "≈". */
  approx: boolean;
  /** Where an `eta` came from ("17TRACK", "розрахунок за маршрутом"…). */
  source?: string;
}

export const SHEET_STATUS_LABEL: Record<SheetStatus, string> = {
  planned: 'Заплановано',
  in_transit: 'В дорозі',
  arrived: 'Прибуло',
  customs: 'Розмитнено',
  delivered: 'Доставлено',
};

export const ISSUE_LABEL: Record<SheetIssue, string> = {
  overdue: 'План прибуття минув, а «розмитнено / доставлено» немає',
  date_unparsed: 'Дату не розпізнано',
  year_guessed: 'Рік у даті не вказано — вгадано',
  container_not_number: 'У колонці «№ контейнер» не номер',
  number_mangled: 'Номер зіпсовано форматом (1,42551E+11)',
  no_dates: 'Немає дат',
};

/** Issues that need a logist's attention (a guessed year alone is just shown). */
const ATTENTION: SheetIssue[] = ['overdue', 'date_unparsed', 'container_not_number', 'number_mangled', 'no_dates'];

interface DbRow {
  id: string;
  tab: SheetTab;
  row_index: number;
  data: TrackingRow | (WarehouseRow & { approx: SheetDate | null });
  status: SheetStatus;
  active: boolean;
  recent: boolean;
  tracked_id: string | null;
  updated_at: string;
}

export interface CalendarRow {
  id: string;
  tab: SheetTab;
  rowIndex: number;
  url: string | null;
  product: string;
  status: SheetStatus;
  statusLabel: string;
  active: boolean;
  number: string | null;
  carrier: string | null;
  carrierName: string | null;
  mode: string | null;
  forwarder: string;
  logist: string;
  origin: string;
  destination: string;
  departure: SheetDate | null;
  arrival: SheetDate | null;
  statusDate: SheetDate | null;
  comment: string;
  weight: string;
  line: string;
  refNo: string;
  customsPlace: string;
  warehouse: string;
  issues: Array<{ code: SheetIssue; label: string }>;
  trackedId: string | null;
  track: { status: string; statusLabel: string; eta: string | null; source: string } | null;
  // warehouse tab
  qty?: string;
  when?: string;
  fits?: string;
}

const day = (v: string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : null);

function sourceName(source: string): string {
  if (source === 'api:17track') return '17TRACK';
  if (source === 'api:novaposhta') return 'Нова Пошта';
  if (source.startsWith('api:')) return `API ${source.slice(4)}`;
  if (source.startsWith('scrape:')) return `сайт перевізника`;
  return source;
}

function toCalendarRow(r: DbRow, t: TrackedRow | undefined): CalendarRow {
  if (r.tab === 'warehouse') {
    const w = r.data as WarehouseRow & { approx: SheetDate | null };
    return {
      id: r.id,
      tab: r.tab,
      rowIndex: r.row_index,
      url: sheetRowUrl('warehouse', r.row_index),
      product: w.product,
      status: 'planned',
      statusLabel: 'Заїзд на склад БЦ',
      active: true,
      number: null,
      carrier: null,
      carrierName: null,
      mode: null,
      forwarder: '',
      logist: '',
      origin: '',
      destination: 'Склад БЦ',
      departure: null,
      arrival: w.approx,
      statusDate: null,
      comment: w.note,
      weight: '',
      line: '',
      refNo: '',
      customsPlace: '',
      warehouse: 'БЦ',
      issues: [],
      trackedId: null,
      track: null,
      qty: w.qty,
      when: w.when,
      fits: w.fits,
    };
  }
  const d = r.data as TrackingRow;
  return {
    id: r.id,
    tab: r.tab,
    rowIndex: r.row_index,
    url: sheetRowUrl('tracking', r.row_index),
    product: d.product,
    status: d.status,
    statusLabel: SHEET_STATUS_LABEL[d.status] ?? d.status,
    active: r.active,
    number: d.number,
    carrier: d.carrier,
    carrierName: d.carrier ? (getCarrier(d.carrier)?.name ?? d.carrier) : null,
    mode: d.mode,
    forwarder: d.forwarder,
    logist: d.logist,
    origin: d.origin,
    destination: d.destination,
    departure: d.departure,
    arrival: d.arrival,
    statusDate: d.statusDate,
    comment: [d.comment, d.extra].filter(Boolean).join(' · '),
    weight: d.weight,
    line: d.line,
    refNo: d.refNo,
    customsPlace: d.customsPlace,
    warehouse: d.warehouse,
    issues: d.issues.map((code) => ({ code, label: ISSUE_LABEL[code] })),
    trackedId: r.tracked_id,
    track: t
      ? {
          status: t.status,
          statusLabel: STATUS_LABEL_UK[t.status] ?? t.status,
          eta: t.eta ? new Date(t.eta).toISOString() : null,
          source: t.source,
        }
      : null,
  };
}

async function loadRows(where: string, params: unknown[]): Promise<{ rows: DbRow[]; tracked: Map<string, TrackedRow> }> {
  const { rows } = await query<DbRow>(
    `SELECT id, tab, row_index, data, status, active, recent, tracked_id, updated_at
     FROM sheet_rows WHERE NOT removed AND (${where}) ORDER BY row_index`,
    params,
  );
  const ids = rows.map((r) => r.tracked_id).filter((x): x is string => !!x);
  const tracked = new Map<string, TrackedRow>();
  if (ids.length) {
    const { rows: t } = await query<TrackedRow>('SELECT * FROM tracked_items WHERE id = ANY($1::uuid[])', [ids]);
    for (const x of t) tracked.set(x.id, x);
  }
  return { rows, tracked };
}

/** ETA from tracking when it says something the plan doesn't. */
async function trackingEvent(r: DbRow, row: CalendarRow, t: TrackedRow | undefined): Promise<CalendarEvent | null> {
  if (!t) return null;
  const plan = row.arrival?.date ?? null;
  if (t.status === 'delivered' && t.arrived_at && !['delivered', 'customs'].includes(row.status)) {
    return { id: `${r.id}:fact`, rowId: r.id, type: 'eta', date: day(t.arrived_at)!, approx: false, source: `${sourceName(t.source)} · доставлено` };
  }
  if (['delivered', 'customs'].includes(row.status)) return null;
  if (t.eta && !t.source.startsWith('sheet') && t.source !== 'manual') {
    const eta = day(t.eta)!;
    if (eta !== plan) return { id: `${r.id}:eta`, rowId: r.id, type: 'eta', date: eta, approx: false, source: sourceName(t.source) };
    return null;
  }
  if (!plan && row.active) {
    const live = await liveItem(t).catch(() => null);
    if (live?.eta && live.etaEstimated) {
      return { id: `${r.id}:est`, rowId: r.id, type: 'eta', date: day(live.eta)!, approx: true, source: 'розрахунок за маршрутом' };
    }
  }
  return null;
}

function rowEvents(r: DbRow, row: CalendarRow): CalendarEvent[] {
  const ev: CalendarEvent[] = [];
  if (r.tab === 'warehouse') {
    if (row.arrival) ev.push({ id: `${r.id}:wh`, rowId: r.id, type: 'warehouse', date: row.arrival.date, approx: true });
    return ev;
  }
  if (row.departure) ev.push({ id: `${r.id}:dep`, rowId: r.id, type: 'departure', date: row.departure.date, approx: row.departure.guessed });
  if (row.arrival) ev.push({ id: `${r.id}:arr`, rowId: r.id, type: 'arrival', date: row.arrival.date, approx: row.arrival.guessed });
  if (row.statusDate && ['arrived', 'customs', 'delivered'].includes(row.status)) {
    ev.push({ id: `${r.id}:st`, rowId: r.id, type: row.status as EventType, date: row.statusDate.date, approx: row.statusDate.guessed });
  }
  return ev;
}

export interface CalendarPayload {
  from: string;
  to: string;
  events: CalendarEvent[];
  rows: CalendarRow[];
}

/** Events between two dates (inclusive) + the rows they belong to. */
export async function calendarRange(from: string, to: string): Promise<CalendarPayload> {
  const { rows, tracked } = await loadRows(
    `(departure_on BETWEEN $1 AND $2) OR (arrival_on BETWEEN $1 AND $2) OR (status_on BETWEEN $1 AND $2)
     OR (tracked_id IS NOT NULL AND active)`,
    [from, to],
  );
  const outRows: CalendarRow[] = [];
  const events: CalendarEvent[] = [];
  for (const r of rows) {
    const t = r.tracked_id ? tracked.get(r.tracked_id) : undefined;
    const row = toCalendarRow(r, t);
    const ev = rowEvents(r, row);
    const te = await trackingEvent(r, row, t);
    if (te) ev.push(te);
    const inRange = ev.filter((e) => e.date >= from && e.date <= to);
    if (!inRange.length) continue;
    outRows.push(row);
    events.push(...inRange);
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  return { from, to, events, rows: outRows };
}

/** Rows that need a logist: active or recently added rows with a data problem. */
export async function attentionRows(): Promise<CalendarRow[]> {
  const { rows, tracked } = await loadRows(`tab = 'tracking' AND (active OR recent)`, []);
  return rows
    .map((r) => toCalendarRow(r, r.tracked_id ? tracked.get(r.tracked_id) : undefined))
    .filter((r) => r.issues.some((i) => ATTENTION.includes(i.code)))
    .map((r) => ({ ...r, issues: r.issues.filter((i) => ATTENTION.includes(i.code)) }))
    .sort((a, b) => b.rowIndex - a.rowIndex);
}

export interface SyncState {
  enabled: boolean;
  sheetUrl: string | null;
  tabs: Array<{ tab: string; ok: boolean; rows: number; error: string; syncedAt: string | null }>;
}

export async function syncState(): Promise<Omit<SyncState, 'enabled' | 'sheetUrl'>> {
  const { rows } = await query<{ tab: string; ok: boolean; rows: number; error: string; synced_at: string | null }>(
    'SELECT tab, ok, rows, error, synced_at FROM sheet_tabs ORDER BY tab',
  );
  return { tabs: rows.map((r) => ({ tab: r.tab, ok: r.ok, rows: r.rows, error: r.error, syncedAt: r.synced_at })) };
}

const TYPE_LABEL: Record<EventType, string> = {
  departure: 'Вихід',
  arrival: 'Прибуття (план)',
  arrived: 'Прибуло',
  customs: 'Розмитнено',
  delivered: 'Доставлено',
  eta: 'ETA трекінгу',
  warehouse: 'Заїзд на склад БЦ',
};

/** Excel of the events in a range (one line per event) — for the week / month plan. */
export function calendarXlsx(p: CalendarPayload): Buffer {
  const byId = new Map(p.rows.map((r) => [r.id, r]));
  const aoa: unknown[][] = [
    ['Дата', 'Подія', 'Товар', 'Номер', 'Перевізник', 'Хто везе', 'Звідки', 'Куди', 'Логіст', 'Статус', 'Коментар', 'Рядок таблиці'],
  ];
  for (const e of p.events) {
    const r = byId.get(e.rowId);
    if (!r) continue;
    aoa.push([
      `${e.date.slice(8, 10)}.${e.date.slice(5, 7)}.${e.date.slice(0, 4)}${e.approx ? ' ≈' : ''}`,
      `${TYPE_LABEL[e.type]}${e.source ? ` (${e.source})` : ''}`,
      r.product,
      r.number ?? '',
      r.carrierName ?? '',
      r.forwarder,
      r.origin,
      r.destination,
      r.logist,
      r.statusLabel,
      r.comment,
      r.rowIndex,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [12, 22, 34, 18, 16, 16, 16, 16, 10, 14, 40, 8].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Календар');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
