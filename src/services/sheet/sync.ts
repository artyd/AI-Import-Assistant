import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { query } from '../../db/pool.js';
import { insertNotification } from '../notifications.js';
import { geocode } from '../hub/geocode.js';
import { isManualSea, refreshTracked } from '../hub/track.js';
import type { TrackStatus } from '../hub/types.js';
import {
  approxWarehouseDate,
  parseCsv,
  parseTrackingTab,
  parseWarehouseTab,
  trimGrid,
  type TrackingRow,
  type WarehouseRow,
} from './parse.js';
import { freeTimeOf } from './freetime.js';
import { sheetEnabled, sheetTabs, type SheetTab } from './link.js';

export { sheetEnabled, sheetRowUrl, sheetTabs, type SheetTab } from './link.js';

/**
 * Hourly sync of the team's Google Sheet (the source of truth) into Штурман:
 *
 *   1. every configured tab is fetched through the sheet's public CSV export;
 *   2. tracking rows (Аркуш3) and warehouse-intake rows (Аркуш5) are parsed and
 *      upserted into `sheet_rows` (the calendar reads them); rows that vanished
 *      from the sheet are flagged `removed`;
 *   3. active tracking rows with a recognisable number become TEAM items in the
 *      logistics hub (parcels → 17TRACK / Нова Пошта; sea → plan from the sheet);
 *   4. the responsible logist is notified when a planned arrival changes and the
 *      day before / the day of an arrival.
 *
 * Reference tabs (rates, quantities) are stored as trimmed grids for the chat.
 * A failed fetch never wipes data — rows are only marked removed after a good read.
 */

/** Today in Kyiv as YYYY-MM-DD. */
export function kyivToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(now);
}

/** A sheet day as a timestamp at noon UTC — the same calendar day in any time zone. */
const noon = (d: string | null | undefined) => (d ? `${d}T12:00:00Z` : null);

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const fmt = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

export async function fetchTab(gid: string): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(config.SHEET_ID)}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (!type.includes('csv') || /^\s*<!doctype html/i.test(text)) {
      throw new Error('таблиця не відкрита «для всіх, у кого є посилання»');
    }
    return parseCsv(text);
  } finally {
    clearTimeout(timer);
  }
}

// ── People ───────────────────────────────────────────────────────────────────

interface UserRef {
  id: string;
  name: string;
}

const firstWord = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim().split(/\s+/)[0] ?? '';

/** Short forms → full name (Люда = Людмила); names not listed match themselves. */
const NICK: Record<string, string> = {
  люда: 'людмила',
  людмила: 'людмила',
  мила: 'людмила',
  оля: 'ольга',
  ольга: 'ольга',
  таня: 'тетяна',
  тетяна: 'тетяна',
  татьяна: 'тетяна',
  юля: 'юлія',
  юлія: 'юлія',
  юлия: 'юлія',
  наташа: 'наталія',
  наталія: 'наталія',
  наталья: 'наталія',
  настя: 'анастасія',
  анастасія: 'анастасія',
  анастасия: 'анастасія',
  катя: 'катерина',
  катерина: 'катерина',
  екатерина: 'катерина',
  саша: 'олександр',
  олександр: 'олександр',
  александр: 'олександр',
  олександра: 'олександра',
  александра: 'олександра',
  леся: 'олеся',
  олеся: 'олеся',
  іра: 'ірина',
  ира: 'ірина',
  ірина: 'ірина',
  ирина: 'ірина',
  света: 'світлана',
  світлана: 'світлана',
  светлана: 'світлана',
};

/** Same person by first name: equal, a known short form, or a shared ≥4-letter stem. */
export function sameFirstName(x: string, y: string): boolean {
  const a = firstWord(x);
  const b = firstWord(y);
  if (a.length < 2 || b.length < 2) return false;
  if (a === b || (NICK[a] ?? a) === (NICK[b] ?? b)) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i >= 4;
}

/** "Люда" ↔ "Людмила Коваль" (see sameFirstName). */
export function matchLogist(logist: string, users: UserRef[]): UserRef | null {
  const a = firstWord(logist);
  if (a.length < 2) return null;
  const hits = users.filter((u) => sameFirstName(logist, u.name));
  return hits.length === 1 ? hits[0]! : (hits.find((u) => firstWord(u.name) === a) ?? null);
}

async function loadUsers(): Promise<UserRef[]> {
  const { rows } = await query<UserRef>('SELECT id, name FROM users ORDER BY created_at');
  return rows;
}

async function notifyFor(users: UserRef[], logist: string, type: string, message: string): Promise<void> {
  const who = matchLogist(logist, users);
  for (const u of who ? [who] : users) await insertNotification(u.id, null, type, message);
}

// ── Rows ─────────────────────────────────────────────────────────────────────

interface StoredRow {
  id: string;
  row_key: string;
  hash: string;
  arrival_on: string | null;
  tracked_id: string | null;
  first_seen_at: string;
  removed: boolean;
}

const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);
const toDay = (v: unknown): string | null =>
  v == null ? null : typeof v === 'string' ? v.slice(0, 10) : new Date(v as Date).toISOString().slice(0, 10);

async function loadStored(tab: SheetTab): Promise<Map<string, StoredRow>> {
  const { rows } = await query<StoredRow>(
    `SELECT id, row_key, hash, arrival_on::text AS arrival_on, tracked_id, first_seen_at, removed
     FROM sheet_rows WHERE tab = $1`,
    [tab],
  );
  return new Map(rows.map((r) => [r.row_key, r]));
}

async function upsertRow(
  tab: SheetTab,
  key: string,
  rowIndex: number,
  data: unknown,
  f: { status: string; active: boolean; recent: boolean; departure: string | null; arrival: string | null; statusOn: string | null; logist: string },
  prev: StoredRow | undefined,
): Promise<string> {
  const hash = hashOf(data);
  if (prev && prev.hash === hash && !prev.removed) {
    await query('UPDATE sheet_rows SET row_index = $2, active = $3, recent = $4, last_seen_at = now() WHERE id = $1', [
      prev.id,
      rowIndex,
      f.active,
      f.recent,
    ]);
    return prev.id;
  }
  const { rows } = await query<{ id: string }>(
    `INSERT INTO sheet_rows (tab, row_key, row_index, data, hash, status, active, recent, departure_on, arrival_on, status_on, logist)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tab, row_key) DO UPDATE SET
       row_index = EXCLUDED.row_index, data = EXCLUDED.data, hash = EXCLUDED.hash,
       status = EXCLUDED.status, active = EXCLUDED.active, recent = EXCLUDED.recent,
       departure_on = EXCLUDED.departure_on, arrival_on = EXCLUDED.arrival_on,
       status_on = EXCLUDED.status_on, logist = EXCLUDED.logist,
       removed = FALSE, updated_at = now(), last_seen_at = now()
     RETURNING id`,
    [tab, key, rowIndex, JSON.stringify(data), hash, f.status, f.active, f.recent, f.departure, f.arrival, f.statusOn, f.logist],
  );
  return rows[0]!.id;
}

// ── Hub link ─────────────────────────────────────────────────────────────────

/** Hub status for a hand-kept (sea) item from the sheet's status. */
function hubStatus(r: TrackingRow): TrackStatus {
  switch (r.status) {
    case 'delivered':
      return 'delivered';
    case 'customs':
      return 'delivered';
    case 'arrived':
      return 'at_port';
    case 'in_transit':
      return 'in_transit';
    default:
      return 'info';
  }
}

interface HubItem {
  id: string;
  mode: string;
  carrier: string;
  origin: string;
  destination: string;
  status: string;
  source: string;
}

async function geoPair(text: string, mode: string): Promise<[number | null, number | null] | null> {
  if (!text) return [null, null];
  const p = await geocode(text, mode === 'air' ? 'air' : mode === 'sea' ? 'sea' : undefined);
  return p ? [p[0], p[1]] : null;
}

/**
 * Make sure an active row with a number is a team item in the hub and carries
 * the sheet's plan. Sea items kept by hand take route, dates and status from the
 * sheet; items an official API / 17TRACK tracks only get blanks filled.
 */
async function linkToHub(r: TrackingRow, rowId: string, prevTracked: string | null, owner: UserRef): Promise<string | null> {
  if (!r.number || !r.carrier || !r.kind || !r.mode) return null;
  let id = prevTracked;
  let fresh = false;
  if (id) {
    const { rows } = await query<{ id: string }>('SELECT id FROM tracked_items WHERE id = $1', [id]);
    if (!rows[0]) id = null;
  }
  if (!id) {
    const { rows } = await query<{ id: string }>(
      'SELECT id FROM tracked_items WHERE number = $1 ORDER BY archived, created_at LIMIT 1',
      [r.number],
    );
    id = rows[0]?.id ?? null;
  }
  if (!id) {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO tracked_items (owner_id, number, kind, carrier, mode, label, team)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (owner_id, number) DO UPDATE SET team = TRUE
       RETURNING id`,
      [owner.id, r.number, r.kind, r.carrier, r.mode, r.product.slice(0, 120)],
    );
    id = rows[0]!.id;
    fresh = true;
  }
  await query('UPDATE sheet_rows SET tracked_id = $2 WHERE id = $1', [rowId, id]);
  await query(`UPDATE tracked_items SET team = TRUE, label = $2, archived = FALSE WHERE id = $1`, [id, r.product.slice(0, 120)]);

  const { rows } = await query<HubItem>(
    'SELECT id, mode, carrier, origin, destination, status, source FROM tracked_items WHERE id = $1',
    [id],
  );
  const item = rows[0]!;
  const origin = r.origin.slice(0, 200);
  const destination = r.destination.slice(0, 200);
  if (isManualSea(item.mode, item.carrier)) {
    const o = origin !== item.origin ? await geoPair(origin, item.mode) : undefined;
    const d = destination !== item.destination ? await geoPair(destination, item.mode) : undefined;
    const status = hubStatus(r);
    await query(
      `UPDATE tracked_items SET
         origin = $2, destination = $3,
         origin_lat = CASE WHEN $4 THEN $5 ELSE origin_lat END, origin_lng = CASE WHEN $4 THEN $6 ELSE origin_lng END,
         dest_lat = CASE WHEN $7 THEN $8 ELSE dest_lat END, dest_lng = CASE WHEN $7 THEN $9 ELSE dest_lng END,
         departed_at = $10, eta = $11, first_eta = COALESCE(first_eta, $11),
         arrived_at = CASE WHEN $12 = 'delivered' THEN COALESCE($13, arrived_at, now()) ELSE arrived_at END,
         status = $12, status_text = $14,
         source = CASE WHEN source IN ('none', 'manual', 'sheet') THEN 'sheet' ELSE source END,
         last_changed_at = CASE WHEN status <> $12 THEN now() ELSE last_changed_at END
       WHERE id = $1`,
      [
        id,
        origin,
        destination,
        o !== undefined,
        o?.[0] ?? null,
        o?.[1] ?? null,
        d !== undefined,
        d?.[0] ?? null,
        d?.[1] ?? null,
        noon(r.departure?.date),
        noon(r.arrival?.date),
        status,
        noon(r.statusDate?.date),
        (r.comment || r.extra).slice(0, 300),
      ],
    );
  } else {
    // Carrier data wins for API-tracked items; the sheet only fills blanks.
    if (!item.origin && origin) {
      const o = await geoPair(origin, item.mode);
      await query('UPDATE tracked_items SET origin = $2, origin_lat = $3, origin_lng = $4 WHERE id = $1', [id, origin, o?.[0] ?? null, o?.[1] ?? null]);
    }
    if (!item.destination && destination) {
      const d = await geoPair(destination, item.mode);
      await query('UPDATE tracked_items SET destination = $2, dest_lat = $3, dest_lng = $4 WHERE id = $1', [id, destination, d?.[0] ?? null, d?.[1] ?? null]);
    }
    if (fresh) await refreshTracked(id).catch(() => undefined);
  }
  return id;
}

/** A row that left play: hand-kept items close; vanished rows archive. */
async function closeInHub(trackedId: string, r: TrackingRow | null): Promise<void> {
  const { rows } = await query<HubItem>('SELECT id, mode, carrier, origin, destination, status, source FROM tracked_items WHERE id = $1', [trackedId]);
  const item = rows[0];
  if (!item || !isManualSea(item.mode, item.carrier)) return;
  if (!r) {
    await query('UPDATE tracked_items SET archived = TRUE WHERE id = $1', [trackedId]);
    return;
  }
  if (r.status === 'delivered' || r.status === 'customs') {
    await query(
      `UPDATE tracked_items SET status = 'delivered', arrived_at = COALESCE($2, arrived_at, now()),
         last_changed_at = CASE WHEN status <> 'delivered' THEN now() ELSE last_changed_at END
       WHERE id = $1`,
      [trackedId, noon(r.statusDate?.date ?? r.arrival?.date)],
    );
  }
}

// ── Sync ─────────────────────────────────────────────────────────────────────

export interface SyncResult {
  ok: boolean;
  tabs: Record<string, { ok: boolean; rows: number; error?: string }>;
  hubLinked: number;
  notified: number;
}

async function saveTabState(tab: SheetTab, gid: string, ok: boolean, rows: number, error: string, grid: string[][] | null) {
  await query(
    `INSERT INTO sheet_tabs (tab, gid, grid, rows, ok, error, synced_at) VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (tab) DO UPDATE SET gid = EXCLUDED.gid,
       grid = COALESCE(EXCLUDED.grid, sheet_tabs.grid), rows = CASE WHEN EXCLUDED.ok THEN EXCLUDED.rows ELSE sheet_tabs.rows END,
       ok = EXCLUDED.ok, error = EXCLUDED.error, synced_at = now()`,
    [tab, gid, grid ? JSON.stringify(grid) : null, rows, ok, error.slice(0, 300)],
  );
}

async function syncTracking(grid: string[][], today: string, users: UserRef[]): Promise<{ rows: number; linked: number; notified: number }> {
  const parsed = parseTrackingTab(grid, today);
  const stored = await loadStored('tracking');
  const fallbackOwner = users[0];
  let linked = 0;
  let notified = 0;
  const seen = new Set<string>();
  for (const r of parsed) {
    seen.add(r.key);
    const prev = stored.get(r.key);
    const id = await upsertRow(
      'tracking',
      r.key,
      r.rowIndex,
      r,
      {
        status: r.status,
        active: r.active,
        recent: r.recent,
        departure: r.departure?.date ?? null,
        arrival: r.arrival?.date ?? null,
        statusOn: r.statusDate?.date ?? null,
        logist: r.logist,
      },
      prev,
    );

    // Planned arrival changed in the sheet → tell the responsible logist.
    const oldArr = toDay(prev?.arrival_on);
    const newArr = r.arrival?.date ?? null;
    if (prev && oldArr && newArr && oldArr !== newArr && r.active) {
      await notifyFor(users, r.logist, `sheet:${id}:plan:${newArr}`, `📅 ${r.product}: план прибуття змінено ${fmt(oldArr)} → ${fmt(newArr)} (таблиця, рядок ${r.rowIndex}).`);
      notified += 1;
    }
    if (r.active && newArr === addDays(today, 1)) {
      await notifyFor(users, r.logist, `sheet:${id}:d1:${newArr}`, `🗓 Завтра прибуває: ${r.product}${r.destination ? ` → ${r.destination}` : ''}.`);
      notified += 1;
    } else if (r.active && newArr === today) {
      await notifyFor(users, r.logist, `sheet:${id}:d0:${newArr}`, `🗓 Сьогодні прибуття: ${r.product}${r.destination ? ` → ${r.destination}` : ''}.`);
      notified += 1;
    }
    // Port free time running out → demurrage soon.
    const ft = r.active ? freeTimeOf(r) : null;
    if (ft && (ft.end === addDays(today, 2) || ft.end === today)) {
      const when = ft.end === today ? 'сьогодні останній день' : `закінчується ${fmt(ft.end)} (за 2 дні)`;
      await notifyFor(
        users,
        r.logist,
        `sheet:${id}:free:${ft.end}:${ft.end === today ? 0 : 2}`,
        `⏳ ${r.product}${r.destination ? ` (${r.destination})` : ''}: безкоштовне зберігання в порту — ${when}; далі демередж.`,
      );
      notified += 1;
    }

    if (r.active && fallbackOwner) {
      const owner = matchLogist(r.logist, users) ?? fallbackOwner;
      const tid = await linkToHub(r, id, prev?.tracked_id ?? null, owner).catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.error(`Sheet → hub (row ${r.rowIndex}):`, err.message);
        return null;
      });
      if (tid) linked += 1;
    } else if (prev?.tracked_id) {
      await closeInHub(prev.tracked_id, r);
    }
  }
  // Rows gone from the sheet (only after a good read with data).
  if (parsed.length > 0) {
    for (const [key, s] of stored) {
      if (seen.has(key) || s.removed) continue;
      await query('UPDATE sheet_rows SET removed = TRUE, active = FALSE, updated_at = now() WHERE id = $1', [s.id]);
      if (s.tracked_id) await closeInHub(s.tracked_id, null);
    }
  }
  return { rows: parsed.length, linked, notified };
}

async function syncWarehouse(grid: string[][], today: string): Promise<number> {
  const parsed: WarehouseRow[] = parseWarehouseTab(grid);
  const stored = await loadStored('warehouse');
  const seen = new Set<string>();
  for (const w of parsed) {
    seen.add(w.key);
    const prev = stored.get(w.key);
    const firstSeen = prev ? kyivToday(new Date(prev.first_seen_at)) : today;
    const approx = approxWarehouseDate(w.when, firstSeen);
    await upsertRow(
      'warehouse',
      w.key,
      w.rowIndex,
      { ...w, approx },
      { status: 'planned', active: true, recent: true, departure: null, arrival: approx?.date ?? null, statusOn: null, logist: '' },
      prev,
    );
  }
  if (parsed.length > 0) {
    for (const [key, s] of stored) {
      if (!seen.has(key) && !s.removed) await query('UPDATE sheet_rows SET removed = TRUE, active = FALSE WHERE id = $1', [s.id]);
    }
  }
  return parsed.length;
}

// ── Morning digest ───────────────────────────────────────────────────────────

/** Hour of the day in Kyiv (0–23). */
export function kyivHour(now = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

interface DigestRow {
  product: string;
  forwarder: string;
  arrival_on: string | null;
  t_eta: string | null;
  t_source: string | null;
}

/**
 * Once a day (first sync after 08:00 Kyiv) every user gets a bell digest: what
 * arrives this week, what is past its planned arrival, and where carrier
 * tracking says it will be ≥ 2 days later than the sheet. Deduped per day.
 */
export async function sendDailyDigest(today: string, users: UserRef[], now = new Date()): Promise<boolean> {
  if (kyivHour(now) < 8 || !users.length) return false;
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(today, -dow);
  const sunday = addDays(monday, 6);
  const { rows } = await query<DigestRow>(
    `SELECT s.data->>'product' AS product, COALESCE(s.data->>'forwarder', '') AS forwarder,
            s.arrival_on::text AS arrival_on, t.eta AS t_eta, t.source AS t_source
     FROM sheet_rows s LEFT JOIN tracked_items t ON t.id = s.tracked_id
     WHERE s.tab = 'tracking' AND NOT s.removed AND s.active`,
  );
  const week = rows.filter((r) => r.arrival_on && r.arrival_on >= monday && r.arrival_on <= sunday);
  const overdue = rows.filter((r) => r.arrival_on && r.arrival_on < today);
  const late = rows.filter((r) => {
    if (!r.arrival_on || !r.t_eta || !r.t_source?.startsWith('api:')) return false;
    const eta = new Date(r.t_eta).toISOString().slice(0, 10);
    return Date.parse(eta) - Date.parse(r.arrival_on) >= 2 * 86_400_000;
  });
  if (!week.length && !overdue.length && !late.length) return false;
  const name = (r: DigestRow) => `${r.product}${r.forwarder ? ` (${r.forwarder})` : ''}`;
  const parts = [`☀️ Зведення на ${fmt(today)}.`];
  if (week.length) {
    const list = week
      .sort((a, b) => a.arrival_on!.localeCompare(b.arrival_on!))
      .slice(0, 8)
      .map((r) => `${name(r)} — ${fmt(r.arrival_on!).slice(0, 5)}`);
    parts.push(`Цього тижня прибуває ${week.length}: ${list.join('; ')}${week.length > 8 ? '…' : ''}.`);
  }
  if (overdue.length) parts.push(`План минув, статусу «розмитнено / доставлено» немає: ${overdue.length} (${overdue.slice(0, 5).map(name).join('; ')}${overdue.length > 5 ? '…' : ''}).`);
  if (late.length) parts.push(`Трекінг показує запізнення ≥ 2 дн: ${late.slice(0, 5).map(name).join('; ')}${late.length > 5 ? '…' : ''}.`);
  const message = parts.join(' ').slice(0, 1200);
  for (const u of users) await insertNotification(u.id, null, `digest:${today}`, message);
  return true;
}

let running: Promise<SyncResult> | null = null;

/** Run one sync (concurrent callers share the same run). */
export function syncSheet(now = new Date()): Promise<SyncResult> {
  if (!running) running = doSync(now).finally(() => (running = null));
  return running;
}

async function doSync(now: Date): Promise<SyncResult> {
  const result: SyncResult = { ok: true, tabs: {}, hubLinked: 0, notified: 0 };
  if (!sheetEnabled()) return { ...result, ok: false };
  const today = kyivToday(now);
  const users = await loadUsers();
  for (const { tab, gid } of sheetTabs()) {
    let grid: string[][];
    try {
      grid = await fetchTab(gid);
    } catch (err) {
      const msg = (err as Error).message;
      result.ok = false;
      result.tabs[tab] = { ok: false, rows: 0, error: msg };
      await saveTabState(tab, gid, false, 0, msg, null);
      continue;
    }
    try {
      let rows: number;
      if (tab === 'tracking') {
        const t = await syncTracking(grid, today, users);
        rows = t.rows;
        result.hubLinked += t.linked;
        result.notified += t.notified;
        if (await sendDailyDigest(today, users, now).catch(() => false)) result.notified += 1;
      } else if (tab === 'warehouse') {
        rows = await syncWarehouse(grid, today);
      } else {
        rows = trimGrid(grid).length;
      }
      result.tabs[tab] = { ok: true, rows };
      await saveTabState(tab, gid, true, rows, '', tab === 'rates' || tab === 'quantities' ? trimGrid(grid) : null);
    } catch (err) {
      const msg = (err as Error).message;
      result.ok = false;
      result.tabs[tab] = { ok: false, rows: 0, error: msg };
      await saveTabState(tab, gid, false, 0, msg, null);
    }
  }
  return result;
}
