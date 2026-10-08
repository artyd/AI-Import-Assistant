// Logist calendar over the team Google Sheet — wire types, API calls and the
// date maths of the week / month / year views. Dates are plain YYYY-MM-DD
// strings (calendar days, no time zone), compared as strings.

import { api, downloadBlob } from "@/lib/api";

export type CalEventType = "departure" | "arrival" | "arrived" | "customs" | "delivered" | "eta" | "warehouse" | "free_end";
export type CalView = "list" | "week" | "month" | "year";

export interface SheetDate {
  date: string;
  guessed: boolean;
}

export interface CalEvent {
  id: string;
  rowId: string;
  type: CalEventType;
  date: string;
  approx: boolean;
  source?: string;
}

export interface CalRow {
  id: string;
  tab: "tracking" | "warehouse";
  rowIndex: number;
  url: string | null;
  product: string;
  status: "planned" | "in_transit" | "arrived" | "customs" | "delivered";
  statusLabel: string;
  active: boolean;
  number: string | null;
  carrier: string | null;
  carrierName: string | null;
  mode: "sea" | "air" | "courier" | "domestic" | null;
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
  issues: Array<{ code: string; label: string }>;
  cargoType: CargoType;
  /** Tracking page for the number (the sheet's link, else the carrier's). */
  trackLink: string | null;
  /** Port free time (sea): end = last free day; source of the days. */
  freeTime: { start: string; end: string; days: number; source: "sheet" | "line" | "default"; fromActual: boolean } | null;
  notesCount: number;
  trackedId: string | null;
  track: { status: string; statusLabel: string; eta: string | null; source: string } | null;
  qty?: string;
  when?: string;
  fits?: string;
}

export interface SyncInfo {
  enabled: boolean;
  sheetUrl: string | null;
  tabs: Array<{ tab: string; ok: boolean; rows: number; error: string; syncedAt: string | null }>;
}

export interface CalendarResponse {
  from: string;
  to: string;
  events: CalEvent[];
  rows: CalRow[];
  sync: SyncInfo;
}

export interface Punctuality {
  forwarder: string;
  count: number;
  onTime: number;
  avgDelay: number;
  maxDelay: number;
  overdueOpen: number;
}

export interface SheetNote {
  id: string;
  text: string;
  userId: string | null;
  userName: string;
  createdAt: string;
}

export const calendarApi = {
  punctuality: () => api<{ rows: Punctuality[] }>("/api/calendar/punctuality"),
  notes: (rowId: string) => api<{ notes: SheetNote[] }>(`/api/calendar/rows/${rowId}/notes`),
  addNote: (rowId: string, text: string) =>
    api<{ notes: SheetNote[] }>(`/api/calendar/rows/${rowId}/notes`, { method: "POST", body: { text } }),
  deleteNote: (noteId: string) => api<{ notes: SheetNote[] }>(`/api/calendar/notes/${noteId}`, { method: "DELETE" }),
  range: (from: string, to: string) => api<CalendarResponse>(`/api/calendar?from=${from}&to=${to}`),
  attention: () => api<{ rows: CalRow[] }>("/api/calendar/attention"),
  sync: () => api<{ sync: SyncInfo }>("/api/sheet/sync", { method: "POST" }),
  exportXlsx: (from: string, to: string) =>
    downloadBlob(`/api/calendar/export.xlsx?from=${from}&to=${to}`, `calendar-${from}_${to}.xlsx`),
};

export const EVENT_META: Record<CalEventType, { label: string; color: string; icon: string }> = {
  // Event colours are what tells departure from arrival at a glance (the
  // forwarder's colour is the thin bar on the left).
  departure: { label: "Вихід", color: "#ea580c", icon: "↗" },
  arrival: { label: "Прибуття (план)", color: "#2563eb", icon: "⚓" },
  arrived: { label: "Прибуло", color: "#0d9488", icon: "📍" },
  customs: { label: "Розмитнено", color: "#7c3aed", icon: "🛃" },
  delivered: { label: "Доставлено", color: "#16a34a", icon: "✓" },
  eta: { label: "ETA трекінгу", color: "#ca8a04", icon: "⏱" },
  warehouse: { label: "Склад БЦ", color: "#92400e", icon: "🏬" },
  free_end: { label: "Кінець free time", color: "#dc2626", icon: "⏳" },
};

export type CargoType = "samples" | "groupage" | "lcl" | "fcl" | "air" | "parcel" | "other" | "warehouse";

/** Cargo type → icon on the calendar mark. */
export const CARGO_META: Record<CargoType, { label: string; icon: string }> = {
  fcl: { label: "Контейнер", icon: "🚢" },
  groupage: { label: "Збірник", icon: "📦" },
  lcl: { label: "LCL", icon: "🧩" },
  air: { label: "Авіа", icon: "✈️" },
  parcel: { label: "Посилка", icon: "📮" },
  samples: { label: "Зразки", icon: "🧪" },
  other: { label: "Вантаж", icon: "•" },
  warehouse: { label: "Склад БЦ", icon: "🏬" },
};
export const CARGO_ORDER: CargoType[] = ["fcl", "groupage", "lcl", "air", "parcel", "samples", "other", "warehouse"];

/** Forwarder → colour of the mark (fixed for the team's forwarders, hashed for others). */
const FORWARDER_COLORS: Record<string, string> = {
  Мультикс: "#2563eb",
  Еврофорвард: "#16a34a",
  DSV: "#0891b2",
  Ксиоми: "#db2777",
  "Ксиоми / DSV": "#be185d",
  Трансвосток: "#ea580c",
  Айкарго: "#7c3aed",
  DHL: "#ca8a04",
  FedEx: "#9333ea",
  Мист: "#dc2626",
  TNT: "#f97316",
  UPS: "#854d0e",
  "Нова Пошта": "#e11d48",
  Постачальник: "#475569",
};
const EXTRA_COLORS = ["#0d9488", "#4f46e5", "#65a30d", "#c026d3", "#0369a1", "#b45309", "#be123c", "#15803d"];

export function forwarderColor(name: string): string {
  if (!name) return "var(--muted)";
  if (FORWARDER_COLORS[name]) return FORWARDER_COLORS[name]!;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return EXTRA_COLORS[h % EXTRA_COLORS.length]!;
}

/** Event type → shape of the mark (the colour is the forwarder's). */
export const EVENT_SHAPE: Record<CalEventType, { border: string; mark: string }> = {
  departure: { border: "dashed", mark: "↗" },
  arrival: { border: "solid", mark: "⚑" },
  eta: { border: "dotted", mark: "⏱" },
  arrived: { border: "solid", mark: "📍" },
  customs: { border: "double", mark: "🛃" },
  delivered: { border: "double", mark: "✓" },
  warehouse: { border: "solid", mark: "🏬" },
  free_end: { border: "solid", mark: "⏳" },
};

export const EVENT_ORDER: CalEventType[] = ["departure", "arrival", "eta", "arrived", "free_end", "customs", "delivered", "warehouse"];

export const MODE_LABEL_CAL: Record<string, string> = {
  sea: "Море",
  air: "Авіа",
  courier: "Курʼєр",
  domestic: "Україна",
};

// ── Dates ────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(utc(d) + n * DAY).toISOString().slice(0, 10);

/** Today in Kyiv (the team's calendar day). */
export function todayKyiv(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(now);
}

export function mondayOf(d: string): string {
  const dow = (new Date(utc(d)).getUTCDay() + 6) % 7;
  return addDays(d, -dow);
}

export function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`;
}

export function addMonths(d: string, n: number): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
}

export function daysInMonth(d: string): number {
  return new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate();
}

/** The date window a view fetches (month = the whole 6-week grid). */
export function viewRange(view: CalView, anchor: string): [string, string] {
  if (view === "list") {
    const start = monthStart(anchor);
    return [start, addDays(start, daysInMonth(start) - 1)];
  }
  if (view === "week") {
    const m = mondayOf(anchor);
    return [m, addDays(m, 6)];
  }
  if (view === "month") {
    const start = mondayOf(monthStart(anchor));
    return [start, addDays(start, 41)];
  }
  const y = anchor.slice(0, 4);
  return [`${y}-01-01`, `${y}-12-31`];
}

export function shiftAnchor(view: CalView, anchor: string, dir: -1 | 1): string {
  if (view === "week") return addDays(anchor, 7 * dir);
  if (view === "month" || view === "list") return addMonths(monthStart(anchor), dir);
  return `${Number(anchor.slice(0, 4)) + dir}-01-01`;
}

export const MONTHS_UK = [
  "Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень",
  "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень",
];
const MONTHS_GEN = [
  "січня", "лютого", "березня", "квітня", "травня", "червня",
  "липня", "серпня", "вересня", "жовтня", "листопада", "грудня",
];
export const WEEKDAYS_UK = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

export function viewTitle(view: CalView, anchor: string): string {
  if (view === "year") return anchor.slice(0, 4);
  if (view === "month" || view === "list") return `${MONTHS_UK[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}`;
  const [a, b] = viewRange("week", anchor);
  const da = Number(a.slice(8, 10));
  const db = Number(b.slice(8, 10));
  const ma = MONTHS_GEN[Number(a.slice(5, 7)) - 1];
  const mb = MONTHS_GEN[Number(b.slice(5, 7)) - 1];
  return ma === mb ? `${da}–${db} ${mb} ${b.slice(0, 4)}` : `${da} ${ma} – ${db} ${mb} ${b.slice(0, 4)}`;
}

export const fmtDay = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

/** ISO-8601 week number. */
export function isoWeek(d: string): number {
  const t = new Date(utc(d));
  const dow = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dow + 3); // Thursday of this week
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t.getTime() - firstThu.getTime()) / DAY - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}

export const isWeekend = (d: string) => [0, 6].includes(new Date(utc(d)).getUTCDay());

/** Orthodox Easter (Julian computus → Gregorian date) — Ukraine's Easter / Trinity. */
function orthodoxEaster(y: number): string {
  const a = y % 4;
  const b = y % 7;
  const c = y % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return addDays(`${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, 13);
}

/**
 * Ukrainian public holidays (calendar marks only — under martial law they are
 * working days).
 */
export function uaHoliday(d: string): string | null {
  const y = Number(d.slice(0, 4));
  const md = d.slice(5);
  const fixed: Record<string, string> = {
    "01-01": "Новий рік",
    "03-08": "Міжнародний жіночий день",
    "05-01": "День праці",
    "05-08": "День памʼяті та перемоги",
    "06-28": "День Конституції",
    "07-15": "День Державності",
    "08-24": "День Незалежності",
    "10-01": "День захисників і захисниць",
    "12-25": "Різдво Христове",
  };
  if (fixed[md]) return fixed[md]!;
  const easter = orthodoxEaster(y);
  if (d === easter) return "Великдень";
  if (d === addDays(easter, 49)) return "Трійця";
  return null;
}

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

/** Same person by first name: equal, a known short form (Люда = Людмила) or a shared ≥4-letter stem. */
export function sameLogist(x: string, y: string): boolean {
  const f = (s: string) => s.toLowerCase().replace(/ё/g, "е").trim().split(/\s+/)[0] ?? "";
  const a = f(x);
  const b = f(y);
  if (a.length < 2 || b.length < 2) return false;
  if (a === b || (NICK[a] ?? a) === (NICK[b] ?? b)) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i >= 4;
}

/** Days from today to `d` (negative = in the past). */
export function daysFrom(today: string, d: string): number {
  return Math.round((utc(d) - utc(today)) / DAY);
}
