import { createHash } from 'node:crypto';
import { trackingUrl, type HubMode } from '../hub/carriers.js';
import { detectNumber, type NumberKind } from '../hub/detect.js';

/**
 * Parsing the team's Google Sheet (tracking tab "Аркуш3" + warehouse tab
 * "Аркуш5"). The sheet is hand-kept, so the data is messy:
 *
 *  - dates in any format ("19.03.2025", "11/09", "17.9.2026", "16/01/2026",
 *    US "9/18/26" pasted from FedEx) and often WITHOUT a year → the year nearest
 *    to today (±6 months), arrival never before departure, flagged `guessed`;
 *  - some columns have no header (weight, line, second arrival place, the
 *    responsible logist, a second status column) → found by position next to a
 *    named column;
 *  - the status lives in free text ("растаможен 23/04/2025", "доставлено клиенту
 *    03/04/2025", "Delivered Friday, 9/18/2026");
 *  - the tracking number may sit in "№ контейнер", "№ ТТН" or only in the
 *    carrier link ("…/tracking/MRSU6298959", "?tracking-id=…", base64 params).
 *
 * Pure — no I/O, `today` is injected. Unit-tested in __tests__/parse.spec.ts.
 */

// ── CSV ──────────────────────────────────────────────────────────────────────

/** RFC 4180 CSV (quoted fields may contain commas, quotes and newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ── Dates ────────────────────────────────────────────────────────────────────

export interface SheetDate {
  /** YYYY-MM-DD */
  date: string;
  /** The year was not written — picked as the one nearest to today. */
  guessed: boolean;
}

const DAY = 86_400_000;
const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const utc = (s: string) => Date.parse(`${s}T00:00:00Z`);

function validDmy(d: number, m: number, y: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function nearestYear(d: number, m: number, today: string): number | null {
  const ref = utc(today);
  const y0 = Number(today.slice(0, 4));
  let best: number | null = null;
  for (const y of [y0 - 1, y0, y0 + 1]) {
    if (!validDmy(d, m, y)) continue;
    if (best == null || Math.abs(utc(iso(y, m, d)) - ref) < Math.abs(utc(iso(best, m, d)) - ref)) best = y;
  }
  return best;
}

/**
 * First date in a cell. Day-first (Ukrainian), falling back to month-first only
 * when day-first is impossible ("9/18/26"). `usFirst` = text pasted from a US
 * carrier page, where month-first is the norm.
 */
export function parseSheetDate(raw: string, today: string, usFirst = false): SheetDate | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // Google Sheets serial day number (days since 1899-12-30) when a date cell lost its format.
  if (/^\d{5}$/.test(s)) {
    const n = Number(s);
    if (n > 43000 && n < 50000) {
      const t = new Date(Date.UTC(1899, 11, 30) + n * DAY);
      return { date: t.toISOString().slice(0, 10), guessed: false };
    }
  }
  const m = s.match(/(?<!\d)(\d{1,4})[./-](\d{1,2})(?:[./-](\d{2,4}))?(?!\d)/);
  if (!m) return null;
  let a = Number(m[1]);
  let b = Number(m[2]);
  const yRaw = m[3];
  // ISO "2026-10-09"
  if (m[1]!.length === 4 && yRaw) {
    const y = a;
    const mo = b;
    const d = Number(yRaw);
    return validDmy(d, mo, y) ? { date: iso(y, mo, d), guessed: false } : null;
  }
  if (m[1]!.length > 2) return null;
  if (usFirst || (b > 12 && a <= 12)) [a, b] = [b, a];
  const d = a;
  const mo = b;
  if (yRaw) {
    let y = Number(yRaw);
    if (yRaw.length === 2) y += 2000;
    if (yRaw.length === 3) return null;
    return validDmy(d, mo, y) ? { date: iso(y, mo, d), guessed: false } : null;
  }
  const y = nearestYear(d, mo, today);
  return y == null ? null : { date: iso(y, mo, d), guessed: true };
}

const shiftYear = (x: SheetDate, by: number): SheetDate => ({
  date: `${Number(x.date.slice(0, 4)) + by}${x.date.slice(4)}`,
  guessed: true,
});

/**
 * Fix guessed years within one row: a guessed date takes the year that puts it
 * closest to the row's other, explicit date — and arrival never before departure.
 */
export function reconcileYears(dep: SheetDate | null, arr: SheetDate | null): [SheetDate | null, SheetDate | null] {
  if (!dep || !arr) return [dep, arr];
  if (arr.guessed && !dep.guessed) {
    // first year at or after departure
    let a = { ...arr, date: `${dep.date.slice(0, 4)}${arr.date.slice(4)}` };
    if (a.date < dep.date) a = shiftYear(a, 1);
    return [dep, a];
  }
  if (dep.guessed && !arr.guessed) {
    let d = { ...dep, date: `${arr.date.slice(0, 4)}${dep.date.slice(4)}` };
    if (d.date > arr.date) d = shiftYear(d, -1);
    return [d, arr];
  }
  if (arr.date < dep.date) return [dep, shiftYear(arr, 1)];
  return [dep, arr];
}

// ── Status from free text ────────────────────────────────────────────────────

export type SheetStatus = 'planned' | 'in_transit' | 'arrived' | 'customs' | 'delivered';

const STATUS_RULES: Array<{ status: SheetStatus; re: RegExp }> = [
  { status: 'delivered', re: /(доставлен\w*|доставлено|delivered|отриман\w*|получен\w*|выгружен\w*|вигружен\w*|выгрузка|вивантажен\w*)/i },
  { status: 'customs', re: /(растаможен\w*|розмитнен\w*|растаможк\w* завершен\w*)/i },
  { status: 'arrived', re: /(прибыл\w*|прибув\w*|прибула|arrived|vessel arrival|discharg\w*|вивантажено з судна|выгружен\w* с судна)/i },
];

export interface StatusHit {
  status: SheetStatus;
  date: SheetDate | null;
}

/** Most advanced status mentioned in the texts, with the date written after it. */
export function statusFromText(texts: string[], today: string): StatusHit | null {
  for (const rule of STATUS_RULES) {
    for (const t of texts) {
      const m = t.match(rule.re);
      if (!m) continue;
      const after = t.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40);
      const us = /delivered|arrived|discharged/i.test(m[0]);
      const date = parseSheetDate(after, today, us) ?? parseSheetDate(t, today, us);
      return { status: rule.status, date };
    }
  }
  return null;
}

// ── Tracking number + carrier ────────────────────────────────────────────────

/** Carrier hint from the tracking link host / SCAC. */
const HOST_CARRIER: Array<[RegExp, string]> = [
  [/maersk\./, 'maersk'],
  [/msc\.com/, 'msc'],
  [/cma-cgm\./, 'cma'],
  [/coscoshipping\./, 'cosco'],
  [/oocl\./, 'oocl'],
  [/hapag-lloyd\./, 'hapag'],
  [/one-line\./, 'one'],
  [/shipmentlink\.|evergreen/, 'evergreen'],
  [/hmm21\./, 'hmm'],
  [/yangming\./, 'yangming'],
  [/zim\.com/, 'zim'],
  [/wanhai\./, 'wanhai'],
  [/fedex\./, 'fedex'],
  [/ups\.com/, 'ups'],
  [/dhl\./, 'dhl'],
  [/tnt\./, 'tnt'],
  [/meest\./, 'meest'],
  [/novaposhta/, 'novaposhta'],
  [/ukrposhta/, 'ukrposhta'],
];

const SCAC_CARRIER: Record<string, string> = {
  MAEU: 'maersk',
  MSCU: 'msc',
  CMDU: 'cma',
  COSU: 'cosco',
  OOLU: 'oocl',
  HLCU: 'hapag',
  ONEY: 'one',
  EGLV: 'evergreen',
  HDMU: 'hmm',
  YMLU: 'yangming',
  ZIMU: 'zim',
  WHLC: 'wanhai',
};

const AIR_HOST = /(cargo|awb|aircargo|skycargo)/i;
const SEA_HOST = /(searates|shipsgo|track-trace\.com\/container|vesselfinder|marinetraffic)/i;

export function carrierFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const sealine = (u.searchParams.get('sealine') ?? '').toUpperCase();
  if (SCAC_CARRIER[sealine]) return SCAC_CARRIER[sealine]!;
  for (const [re, id] of HOST_CARRIER) if (re.test(host)) return id;
  return null;
}

function modeFromUrl(url: string): HubMode | null {
  try {
    const u = new URL(url.trim());
    if (SEA_HOST.test(u.hostname + u.pathname)) return 'sea';
    if (AIR_HOST.test(u.hostname)) return 'air';
  } catch {
    /* not a URL */
  }
  return null;
}

/** Numbers hidden in a tracking link (query params, path tail, MSC base64 params). */
export function numbersFromUrl(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const k of ['number', 'tracking-id', 'trknbr', 'tracknum', 'parcel_number', 'trackingNumber', 'cargo_number', 'barcode', 'Reference', 'consnumber', 'trakNoParam', 'container']) {
    const v = u.searchParams.get(k);
    if (v) out.push(v);
  }
  const p = u.searchParams.get('params');
  if (p) {
    try {
      const decoded = Buffer.from(p, 'base64').toString('utf8');
      const m = decoded.match(/trackingNumber=([A-Za-z0-9]+)/);
      if (m) out.push(m[1]!);
    } catch {
      /* not base64 */
    }
  }
  const tail = u.pathname.split('/').filter(Boolean).at(-1) ?? '';
  if (/^[A-Z0-9]{8,20}$/i.test(tail) && /\d{5}/.test(tail)) out.push(tail);
  return out;
}

export interface NumberPick {
  number: string;
  carrier: string;
  kind: NumberKind;
  mode: HubMode;
}

/** Excel turned a long number into "1,42551E+11" — the digits are lost. */
export const isMangledNumber = (s: string) => /\d[.,]\d+E\+\d+/i.test(s);

const clean = (s: string) =>
  s
    .toUpperCase()
    .replace(/^(NO|№|N)\s*[.:]*\s*/i, '')
    .replace(/[\s\-./:]/g, '');

const MODE_BY_CARRIER: Record<string, HubMode> = { meest: 'courier', novaposhta: 'domestic', ukrposhta: 'domestic' };

/** Best trackable number from the row's cells + link, with its carrier. */
export function pickNumber(cells: string[], url: string): NumberPick | null {
  const hint = carrierFromUrl(url);
  const candidates = [...cells.flatMap((c) => c.split(/[\n;,]+/)), ...numbersFromUrl(url)]
    .map((c) => c.trim())
    .filter((c) => c && !isMangledNumber(c));
  for (const raw of candidates) {
    const container = raw.toUpperCase().match(/\b[A-Z]{3}[UJZ]\s?\d{6}\s?\d\b/);
    const n = container ? clean(container[0]) : clean(raw);
    if (n.length < 6 || n.length > 30 || !/\d{4}/.test(n) || !/^[A-Z0-9]+$/.test(n)) continue;
    const det = detectNumber(n).candidates;
    const byHint = hint ? det.find((c) => c.carrier === hint) : undefined;
    const best = byHint ?? det[0];
    if (best && (best.confidence >= 0.5 || byHint)) {
      // A generic sea / container hit takes the line from the link when known.
      const carrier = best.carrier === 'sea-generic' && hint ? hint : best.carrier;
      return { number: n, carrier, kind: best.kind, mode: best.mode };
    }
    if (hint) {
      const mode = MODE_BY_CARRIER[hint] ?? (['fedex', 'ups', 'dhl', 'tnt'].includes(hint) ? 'courier' : 'sea');
      const kind: NumberKind = mode === 'sea' ? (/^[A-Z]{3}[UJZ]\d{7}$/.test(n) ? 'container' : 'bl') : 'parcel';
      return { number: n, carrier: hint, kind, mode };
    }
  }
  return null;
}

// ── Columns ──────────────────────────────────────────────────────────────────

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

type Named =
  | 'sheetNo'
  | 'product'
  | 'forwarder'
  | 'qty'
  | 'container'
  | 'ttn'
  | 'arrival'
  | 'destination'
  | 'departure'
  | 'origin'
  | 'trackUrl'
  | 'line'
  | 'logist'
  | 'comment'
  | 'customsPlace'
  | 'warehouse';

const HEADER_RULES: Array<[Named, RegExp]> = [
  ['sheetNo', /^№\s*лист/],
  ['product', /^(товар|номенклатура|продукт)/],
  ['forwarder', /(кто|хто)\s*(везет|везе)|перевозчик|перевізник|экспедитор|експедитор/],
  ['qty', /^(кол-?во|количество|кількість|к-?сть)/],
  ['container', /контейнер/],
  ['ttn', /ттн|awb|накладн/],
  ['arrival', /дата\s*(прибытия|прибуття)|eta/],
  ['destination', /(место|місце)\s*(прибытия|прибуття)|куда|куди/],
  ['departure', /дата\s*(выхода|виходу|отправ|відправ)|etd/],
  ['origin', /(место|місце)\s*(выхода|виходу|отправ|відправ)|откуда|звідки/],
  ['logist', /логист|логіст|ответствен|відповідальн|менеджер/],
  ['line', /линия|лінія|^line/],
  ['trackUrl', /ссылк|посилан|трекинг|трекінг|tracking|link/],
  ['comment', /коммент|комент|примечан|примітк/],
  ['customsPlace', /(место|місце)\s*(растаможки|розмитнення)/],
  ['warehouse', /склад/],
];

export interface ColumnMap {
  named: Partial<Record<Named, number>>;
  ref: number | null;
  weight: number | null;
  line: number | null;
  destination2: number | null;
  logist: number | null;
  extra: number[];
}

const isUrl = (s: string) => /^\s*https?:\/\//i.test(s);

/**
 * Header → column indexes. The sheet is edited by hand, so:
 *  - the tracking-link column is found by CONTENT (the column holding most
 *    http links) — two columns may both be titled «Морская линия»;
 *  - the other «… линия» column is the line name;
 *  - unnamed columns (old layout: weight, line, 2nd arrival place, logist) are
 *    taken by position only when no named column covers them.
 */
export function mapColumns(header: string[], body: string[][] = []): ColumnMap {
  const named: Partial<Record<Named, number>> = {};
  const lineCols: number[] = [];
  header.forEach((h, i) => {
    const f = fold(h);
    if (!f) return;
    if (/линия|лінія|^line/.test(f)) lineCols.push(i);
    for (const [key, re] of HEADER_RULES) {
      if (named[key] == null && re.test(f)) {
        named[key] = i;
        break;
      }
    }
  });
  // Tracking links by content.
  let urlCol: number | null = null;
  let best = 0;
  for (let i = 0; i < header.length; i += 1) {
    const n = body.reduce((acc, r) => acc + (isUrl(r[i] ?? '') ? 1 : 0), 0);
    if (n > best) {
      best = n;
      urlCol = i;
    }
  }
  if (urlCol != null && best >= 1) named.trackUrl = urlCol;
  const lineNamed = lineCols.find((i) => i !== named.trackUrl);
  if (lineNamed != null) named.line = lineNamed;
  else if (named.line === named.trackUrl) delete named.line;

  const blank = (i: number | undefined | null) => (i != null && i >= 0 && i < header.length && !fold(header[i] ?? '') ? i : null);
  const after = (k: Named, by = 1) => (named[k] != null ? blank(named[k]! + by) : null);
  const lastNamed = Math.max(...Object.values(named).map((v) => v ?? -1));
  const extra: number[] = [];
  for (let i = lastNamed + 1; i < header.length; i += 1) if (blank(i) != null) extra.push(i);
  const forwarder2 = after('forwarder', 2);
  return {
    named,
    ref: after('sheetNo'),
    weight: named.qty != null ? named.qty : after('forwarder'),
    line: named.line != null ? named.line : after('forwarder', 1) != null && forwarder2 != null ? forwarder2 : null,
    destination2: after('destination'),
    logist: named.logist != null ? named.logist : after('departure'),
    extra,
  };
}

// ── Forwarder + cargo type ───────────────────────────────────────────────────

const FORWARDERS: Array<[RegExp, string]> = [
  [/мульти?кс|multi?x/i, 'Мультикс'],
  [/еврофорвард|eurofor/i, 'Еврофорвард'],
  [/^дсв$|^dsv$|дсв|\bdsv\b/i, 'DSV'],
  [/ксиоми|ксіомі|xiomi|ksiomi/i, 'Ксиоми'],
  [/трансвосток|transvostok/i, 'Трансвосток'],
  [/айкарго|aicargo|icargo/i, 'Айкарго'],
  [/дхл|\bdhl\b/i, 'DHL'],
  [/федекс|fedex/i, 'FedEx'],
  [/мист|міст|meest/i, 'Мист'],
  [/\btnt\b|тнт/i, 'TNT'],
  [/\bups\b/i, 'UPS'],
  [/нова\s*пошта|новая\s*почта|nova\s*poshta/i, 'Нова Пошта'],
  [/поставщик|постачальник|supplier/i, 'Постачальник'],
];

const COURIER_NAME: Record<string, string> = {
  dhl: 'DHL',
  fedex: 'FedEx',
  ups: 'UPS',
  tnt: 'TNT',
  meest: 'Мист',
  novaposhta: 'Нова Пошта',
  ukrposhta: 'Укрпошта',
};

/**
 * One spelling per forwarder ("мультикс" / "Мультикс" → "Мультикс"; "Ксиоми/ДСВ"
 * → "Ксиоми / DSV"). Numbers / notes that ended up in the column are dropped;
 * a courier shipment without a forwarder is shown under its courier.
 */
export function normalizeForwarder(raw: string, carrier: string | null): string {
  const parts = raw
    .split(/[/,;+]| и | та /)
    .map((p) => p.trim())
    .filter((p) => p && !/\d{3,}/.test(p) && !/^(образ|зразк|q-?ty)/i.test(p));
  const names: string[] = [];
  for (const p of parts) {
    const hit = FORWARDERS.find(([re]) => re.test(p));
    const name = hit ? hit[1] : p.charAt(0).toUpperCase() + p.slice(1);
    if (!names.includes(name)) names.push(name);
  }
  if (!names.length && carrier && COURIER_NAME[carrier]) names.push(COURIER_NAME[carrier]!);
  return names.join(' / ');
}

export type CargoType = 'samples' | 'groupage' | 'lcl' | 'fcl' | 'air' | 'parcel' | 'other';

/** Cargo type from the product name + how it travels (keywords first). */
export function cargoType(product: string, mode: HubMode | null): CargoType {
  if (/образ|зразк|sample/i.test(product)) return 'samples';
  if (/сборник|збірник|groupage/i.test(product)) return 'groupage';
  if (/\blcl\b/i.test(product)) return 'lcl';
  if (mode === 'air') return 'air';
  if (mode === 'courier' || mode === 'domestic') return 'parcel';
  if (mode === 'sea' || /\d\s*конт|контейнер|\bfcl\b/i.test(product)) return 'fcl';
  return 'other';
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export type SheetIssue =
  | 'overdue'
  | 'date_unparsed'
  | 'date_suspicious'
  | 'year_guessed'
  | 'container_not_number'
  | 'number_mangled'
  | 'no_dates';

export interface TrackingRow {
  /** 1-based row number in the sheet (for the "open row" link). */
  rowIndex: number;
  key: string;
  product: string;
  refNo: string;
  /** Normalised forwarder ("Мультикс", "DSV", "Ксиоми / DSV", courier name…). */
  forwarder: string;
  /** As written in the sheet. */
  forwarderRaw: string;
  cargoType: CargoType;
  /** Quantity / weight cell ("Кол-во"). */
  weight: string;
  line: string;
  containerRaw: string;
  ttnRaw: string;
  trackUrl: string;
  /** Where to track the number: the sheet's link, else the carrier's page. */
  trackLink: string | null;
  origin: string;
  destination: string;
  logist: string;
  comment: string;
  customsPlace: string;
  warehouse: string;
  extra: string;
  departure: SheetDate | null;
  arrival: SheetDate | null;
  /** Date the status text gives (customs cleared / delivered / arrived). */
  statusDate: SheetDate | null;
  status: SheetStatus;
  number: string | null;
  carrier: string | null;
  kind: NumberKind | null;
  mode: HubMode | null;
  issues: SheetIssue[];
  /** In play: not cleared / delivered and not long past its arrival. */
  active: boolean;
  /** Among the last rows of the sheet (recently added) — data issues matter here. */
  recent: boolean;
  /** Dated in the working year (only those rows are shown / tracked). */
  inScope: boolean;
}

const cellAt = (row: string[], i: number | null | undefined) => (i == null ? '' : (row[i] ?? '').trim());

export function rowKey(product: string, number: string | null, fallback: string): string {
  return createHash('sha256')
    .update(`${fold(product)}|${number ?? fold(fallback)}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * @param ref  date the year of a year-less date is guessed around: the latest
 *             explicit date of the rows above (the sheet is chronological), else today.
 */
export function parseTrackingRow(
  row: string[],
  rowIndex: number,
  cols: ColumnMap,
  today: string,
  ref: string = today,
  year: string = today.slice(0, 4),
): TrackingRow | null {
  const c = (k: Named) => cellAt(row, cols.named[k]);
  const product = c('product');
  if (!product) return null;
  const containerRaw = c('container');
  const ttnRaw = c('ttn');
  const trackUrl = c('trackUrl');
  const comment = c('comment');
  const extra = cols.extra.map((i) => cellAt(row, i)).filter(Boolean).join(' · ');

  const depRaw = c('departure');
  const arrRaw = c('arrival');
  const [departure, arrival] = reconcileYears(parseSheetDate(depRaw, ref), parseSheetDate(arrRaw, ref));
  const hit = statusFromText([extra, comment].filter(Boolean), arrival?.date ?? departure?.date ?? ref);
  const pick = pickNumber([containerRaw, ttnRaw], trackUrl);

  let status: SheetStatus = hit?.status ?? 'planned';
  if (status === 'planned' && departure && departure.date <= today) status = 'in_transit';

  const issues: SheetIssue[] = [];
  if ((depRaw && !departure) || (arrRaw && !arrival)) issues.push('date_unparsed');
  // A year-less date takes the year of the surrounding rows (2026 in practice) — not
  // an issue. A written year far from the working year is likely a typo (28.08.2028).
  const yr = Number(year);
  if ([departure, arrival].some((d) => d && !d.guessed && Math.abs(Number(d.date.slice(0, 4)) - yr) > 1)) {
    issues.push('date_suspicious');
  }
  if (containerRaw && !/[A-Z]{3}[UJZ]\s?\d{6}\s?\d/i.test(containerRaw) && !/\d{6}/.test(containerRaw)) {
    issues.push('container_not_number');
  }
  if (isMangledNumber(containerRaw) || isMangledNumber(ttnRaw)) issues.push('number_mangled');
  if (!departure && !arrival) issues.push('no_dates');
  const done = status === 'delivered' || status === 'customs';
  if (!done && arrival && arrival.date < today) issues.push('overdue');
  const statusDate = hit?.date ?? null;
  const inScope = [departure, arrival, statusDate].some((d) => !!d && d.date.startsWith(year));
  // In play = not cleared / delivered and dated recently: arrival within the
  // last 30 days or ahead; without an arrival, left within the last 120 days.
  const recent = arrival
    ? utc(today) - utc(arrival.date) <= 30 * DAY
    : !!departure && utc(today) - utc(departure.date) <= 120 * DAY;
  const active = !done && recent && inScope;

  const destination = c('destination') || cellAt(row, cols.destination2);
  const number = pick?.number ?? null;
  const carrier = pick?.carrier ?? carrierFromUrl(trackUrl);
  const mode = pick?.mode ?? modeFromUrl(trackUrl);
  // In this sheet the container column sometimes holds the forwarder instead.
  const forwarderRaw = c('forwarder') || (issues.includes('container_not_number') && !/\d/.test(containerRaw) ? containerRaw : '');
  const link = /^https?:\/\//i.test(trackUrl) ? trackUrl : '';
  return {
    rowIndex,
    key: rowKey(product, number, `${product}|${depRaw}|${arrRaw}`),
    product,
    refNo: cellAt(row, cols.ref),
    forwarder: normalizeForwarder(forwarderRaw, carrier),
    forwarderRaw,
    cargoType: cargoType(product, mode),
    weight: cellAt(row, cols.weight),
    line: cellAt(row, cols.line),
    containerRaw,
    ttnRaw,
    trackUrl: link,
    trackLink: pickTrackLink(link, number, carrier),
    origin: c('origin'),
    destination,
    logist: cellAt(row, cols.logist),
    comment,
    customsPlace: c('customsPlace'),
    warehouse: c('warehouse'),
    extra,
    departure,
    arrival,
    statusDate,
    status,
    number,
    carrier,
    kind: pick?.kind ?? null,
    mode,
    issues,
    active,
    recent: false,
    inScope,
  };
}

/**
 * The sheet's own link wins (the logist chose that site) — unless it is a bare
 * tracking page without this number, then the carrier's page for the number.
 */
export function pickTrackLink(sheetLink: string, number: string | null, carrier: string | null): string | null {
  const own = number && carrier ? trackingUrl(carrier, number) : null;
  if (!sheetLink) return own;
  if (!number || !own) return sheetLink;
  const flat = decodeURIComponent(sheetLink).toUpperCase().replace(/[\s-]/g, '');
  let decoded = '';
  try {
    const p = new URL(sheetLink).searchParams.get('params');
    if (p) decoded = Buffer.from(p, 'base64').toString('utf8').toUpperCase();
  } catch {
    /* not a URL */
  }
  return flat.includes(number) || decoded.includes(number) ? sheetLink : own;
}

/** Rows at the bottom of the sheet count as "recent" for the data-issue list. */
export const RECENT_ROWS = 40;

/** Whole tracking tab → rows (keys made unique when two rows collide). */
export function parseTrackingTab(grid: string[][], today: string): TrackingRow[] {
  const headerAt = grid.findIndex((r) => r.some((c) => /товар|номенклатура/i.test(c)));
  if (headerAt < 0) return [];
  const cols = mapColumns(grid[headerAt]!, grid.slice(headerAt + 1));
  const out: TrackingRow[] = [];
  const seen = new Map<string, number>();
  // Year-less dates are guessed around the latest explicit date above (the sheet
  // is chronological) — but never around a date older than half a year ago.
  const floor = new Date(utc(today) - 183 * DAY).toISOString().slice(0, 10);
  let ref = '';
  for (let i = headerAt + 1; i < grid.length; i += 1) {
    const around = !ref ? today : ref > floor ? ref : floor;
    const r = parseTrackingRow(grid[i]!, i + 1, cols, today, around);
    if (!r) continue;
    const explicit = [r.departure, r.arrival].filter((d): d is SheetDate => !!d && !d.guessed).map((d) => d.date);
    if (explicit.length) ref = explicit.sort().at(-1)!;
    else if (r.departure ?? r.arrival) ref = (r.departure ?? r.arrival)!.date;
    const n = seen.get(r.key) ?? 0;
    seen.set(r.key, n + 1);
    if (n > 0) r.key = `${r.key}-${n}`;
    out.push(r);
  }
  // "Recent" (data issues worth showing): in play, or among the last rows and not
  // dated in another year.
  const last = out.at(-1)?.rowIndex ?? 0;
  for (const r of out) {
    const undated = !r.departure && !r.arrival && !r.statusDate;
    r.recent = r.active || (r.rowIndex > last - RECENT_ROWS && (r.inScope || undated));
  }
  return out;
}

// ── Warehouse tab (planned intake to the БЦ warehouse) ─────────────────────────

export interface WarehouseRow {
  rowIndex: number;
  key: string;
  product: string;
  qty: string;
  when: string;
  fits: string;
  note: string;
}

/**
 * "Аркуш5": nomenclature · qty · when? · fits into БЦ? … with repeated header
 * rows. The "when" column is free text ("на этой неделе") — the calendar anchors
 * it to the week the row was first seen (see `approxWarehouseDate`).
 */
export function parseWarehouseTab(grid: string[][]): WarehouseRow[] {
  const out: WarehouseRow[] = [];
  const seen = new Map<string, number>();
  grid.forEach((r, i) => {
    const product = (r[0] ?? '').trim();
    const qty = (r[1] ?? '').trim();
    if (!product || /^(номенклатура|стовпець|столбец)/i.test(product) || /^кол-?во/i.test(qty)) return;
    const key0 = createHash('sha256').update(`${fold(product)}|${qty}`).digest('hex').slice(0, 24);
    const n = seen.get(key0) ?? 0;
    seen.set(key0, n + 1);
    out.push({
      rowIndex: i + 1,
      key: n ? `${key0}-${n}` : key0,
      product,
      qty,
      when: (r[2] ?? '').trim(),
      fits: (r[3] ?? '').trim(),
      note: r.slice(4).map((c) => c.trim()).filter(Boolean).join(' · '),
    });
  });
  return out;
}

/**
 * The date written in the free-text "when" ("16.01 в порт"), or null. Relative
 * phrases («на этой неделе») have no anchor — the row may be months old — so
 * they get no calendar date (the chat tool still lists them).
 */
export function approxWarehouseDate(when: string, firstSeen: string): SheetDate | null {
  const explicit = parseSheetDate(when, firstSeen);
  // Intake is near-term: a year-less date far ahead of when the row appeared was written last year.
  if (explicit?.guessed && utc(explicit.date) - utc(firstSeen) > 60 * DAY) return shiftYear(explicit, -1);
  return explicit;
}

/** Trim a reference grid (rates / quantities) to its non-empty area. */
export function trimGrid(grid: string[][]): string[][] {
  const rows = grid.filter((r) => r.some((c) => c.trim()));
  let width = 0;
  for (const r of rows) for (let i = r.length - 1; i >= 0; i -= 1) if (r[i]!.trim()) { width = Math.max(width, i + 1); break; }
  return rows.map((r) => r.slice(0, width).map((c) => c.trim()));
}
