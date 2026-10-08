// Logist calendar over the team Google Sheet — wire types, API calls and the
// date maths of the week / month / year views. Dates are plain YYYY-MM-DD
// strings (calendar days, no time zone), compared as strings.

import { api, downloadBlob } from "@/lib/api";

export type CalEventType = "departure" | "arrival" | "arrived" | "customs" | "delivered" | "eta" | "warehouse";
export type CalView = "week" | "month" | "year";

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

export const calendarApi = {
  range: (from: string, to: string) => api<CalendarResponse>(`/api/calendar?from=${from}&to=${to}`),
  attention: () => api<{ rows: CalRow[] }>("/api/calendar/attention"),
  sync: () => api<{ sync: SyncInfo }>("/api/sheet/sync", { method: "POST" }),
  exportXlsx: (from: string, to: string) =>
    downloadBlob(`/api/calendar/export.xlsx?from=${from}&to=${to}`, `calendar-${from}_${to}.xlsx`),
};

export const EVENT_META: Record<CalEventType, { label: string; color: string; icon: string }> = {
  departure: { label: "Вихід", color: "#64748b", icon: "↗" },
  arrival: { label: "Прибуття (план)", color: "var(--accent)", icon: "⚓" },
  arrived: { label: "Прибуло", color: "#0d9488", icon: "📍" },
  customs: { label: "Розмитнено", color: "#7c3aed", icon: "🛃" },
  delivered: { label: "Доставлено", color: "var(--ok)", icon: "✓" },
  eta: { label: "ETA трекінгу", color: "var(--warn)", icon: "⏱" },
  warehouse: { label: "Склад БЦ", color: "#b45309", icon: "🏬" },
};

export const EVENT_ORDER: CalEventType[] = ["departure", "arrival", "eta", "arrived", "customs", "delivered", "warehouse"];

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
  if (view === "month") return addMonths(monthStart(anchor), dir);
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
  if (view === "month") return `${MONTHS_UK[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}`;
  const [a, b] = viewRange("week", anchor);
  const da = Number(a.slice(8, 10));
  const db = Number(b.slice(8, 10));
  const ma = MONTHS_GEN[Number(a.slice(5, 7)) - 1];
  const mb = MONTHS_GEN[Number(b.slice(5, 7)) - 1];
  return ma === mb ? `${da}–${db} ${mb} ${b.slice(0, 4)}` : `${da} ${ma} – ${db} ${mb} ${b.slice(0, 4)}`;
}

export const fmtDay = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

/** Days from today to `d` (negative = in the past). */
export function daysFrom(today: string, d: string): number {
  return Math.round((utc(d) - utc(today)) / DAY);
}
