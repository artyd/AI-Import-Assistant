import type { SupplyMode, SupplySettings, SupplyShipment, SupplyStep } from "./types";

// Pure helpers for the Поставки register (no DOM, unit-tested).

export const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
export const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
export const WEEKDAYS = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];

/** Today in Kyiv as YYYY-MM-DD (the team's calendar day). */
export function kyivToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** `2026-11-07` → `07.11`. */
export function shortDate(d: string): string {
  return d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "";
}

/** The step the shipment is on: the active one, else the next pending, else the last. */
export function currentStep(steps: SupplyStep[]): SupplyStep | null {
  return steps.find((s) => s.state === "active") ?? steps.find((s) => s.state === "pending") ?? steps[steps.length - 1] ?? null;
}

export type DeadlineKind = "none" | "done" | "overdue" | "soon" | "later";

export function deadline(s: Pick<SupplyShipment, "steps">, today: string): { kind: DeadlineKind; step: SupplyStep | null; days: number | null; date: string } {
  const step = currentStep(s.steps);
  if (!step || !step.plan) return { kind: "none", step, days: null, date: "" };
  if (step.actual || step.state === "done") return { kind: "done", step, days: null, date: step.plan };
  const days = daysBetween(today, step.plan);
  return { kind: days < 0 ? "overdue" : days <= 7 ? "soon" : "later", step, days, date: step.plan };
}

/** Short label for the date badge: «−3 дн.», «сьогодні», «через 6 дн.». */
export function deadlineLabel(d: ReturnType<typeof deadline>): string {
  if (d.kind === "none") return "без дати";
  if (d.kind === "done") return "виконано";
  const n = d.days ?? 0;
  if (n < 0) return `−${-n} дн.`;
  if (n === 0) return "сьогодні";
  if (n === 1) return "завтра";
  return `через ${n} дн.`;
}

export type SortKey = "date" | "name" | "updated";

/** Starred shipments first, then by the chosen key. */
export function sortShipments(list: SupplyShipment[], key: SortKey, today: string): SupplyShipment[] {
  const out = [...list];
  const star = (a: SupplyShipment, b: SupplyShipment) => Number(b.pinned) - Number(a.pinned);
  // numeric: "Поставка 2" before "Поставка 10"
  if (key === "name") return out.sort((a, b) => star(a, b) || a.name.localeCompare(b.name, "uk", { numeric: true }));
  if (key === "updated") return out.sort((a, b) => star(a, b) || b.updatedAt.localeCompare(a.updatedAt));
  const rank = (s: SupplyShipment) => {
    const d = deadline(s, today);
    return d.kind === "none" ? "9999" : d.kind === "done" ? `8${d.date}` : d.date;
  };
  return out.sort((a, b) => star(a, b) || rank(a).localeCompare(rank(b)) || a.position - b.position);
}

/** Icon keys a category can wear (drawn in components/supply/KindIcon.tsx). */
export const CATEGORY_ICONS = ["globe", "ukraine", "sample", "box", "truck", "plane", "ship", "train", "flask", "tag"] as const;
export type CategoryIconKey = (typeof CATEGORY_ICONS)[number];

/** The icon set for a category in Довідники, else a guess from its name, else a tag. */
export function categoryIcon(settings: Pick<SupplySettings, "categoryIcons">, category: string): CategoryIconKey {
  const set = settings.categoryIcons?.[category];
  if (set && (CATEGORY_ICONS as readonly string[]).includes(set)) return set as CategoryIconKey;
  const n = category.toLowerCase();
  if (/міжнар|междунар|імпорт|international/.test(n)) return "globe";
  if (/україн|украин/.test(n)) return "ukraine";
  if (/зраз|образ|sample/.test(n)) return "sample";
  return "tag";
}

export const MODES: { key: SupplyMode; label: string }[] = [
  { key: "", label: "За етапами" },
  { key: "sea", label: "Море" },
  { key: "air", label: "Авіа" },
  { key: "rail", label: "Залізниця" },
  { key: "road", label: "Авто" },
  { key: "courier", label: "Курʼєр" },
];

/** Transport: the one set by hand, else read from the stage names; null = unknown. */
export function transportMode(s: Pick<SupplyShipment, "mode" | "steps">): Exclude<SupplyMode, ""> | null {
  if (s.mode) return s.mode;
  const names = s.steps.map((x) => x.name.toLowerCase()).join(" | ");
  if (/виліт|вылет|авіа|авиа|аеропорт|аэропорт/.test(names)) return "air";
  if (/порт|судн|фрахт|коносамент|букінг|букинг/.test(names)) return "sea";
  if (/залізниц|жд|ж\/д|вагон/.test(names)) return "rail";
  if (/кур.?єр|курьер|dhl|fedex|ups|нова пошта|посилк/.test(names)) return "courier";
  if (/автомоб|авто|завантаж|погрузк|машин/.test(names)) return "road";
  return null;
}

const fold = (s: string) => s.toLowerCase().replace(/ё/g, "е");

export function matches(s: SupplyShipment, q: string): boolean {
  const n = fold(q.trim());
  if (!n) return true;
  return fold([s.name, s.note, s.action, s.category, ...s.steps.map((x) => x.name), ...Object.values(s.custom)].join(" ")).includes(n);
}

export interface CalendarEvent {
  shipment: SupplyShipment;
  step: SupplyStep;
  index: number;
  tone: "done" | "active" | "pending" | "overdue";
}

/** Every dated step, by the day it falls on (the fact if known, else the plan). */
export function eventsByDay(list: SupplyShipment[], today: string): Map<string, CalendarEvent[]> {
  const out = new Map<string, CalendarEvent[]>();
  for (const s of list) {
    s.steps.forEach((step, index) => {
      const day = step.actual || step.plan;
      if (!day) return;
      let tone: CalendarEvent["tone"] = step.actual || step.state === "done" ? "done" : step.state === "active" ? "active" : "pending";
      if (!step.actual && step.state !== "done" && step.plan < today) tone = "overdue";
      const arr = out.get(day) ?? [];
      arr.push({ shipment: s, step, index, tone });
      out.set(day, arr);
    });
  }
  return out;
}

/** The 42 days (6 weeks, Monday first) shown for a month. */
export function monthGrid(year: number, month: number): string[] {
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(year, month, 1 - shift)).toISOString().slice(0, 10);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Mark the active step done (fact = today unless set) and move to the next one. */
export function completeActiveStep(steps: SupplyStep[], today: string): SupplyStep[] {
  const i = steps.findIndex((s) => s.state === "active");
  if (i < 0) return steps;
  return steps.map((s, j) => {
    if (j === i) return { ...s, state: "done", actual: s.actual || today };
    if (j === i + 1 && s.state === "pending") return { ...s, state: "active" };
    return s;
  });
}

/** Keep exactly one active step: the first not-done one (when any). */
export function normalizeSteps(steps: SupplyStep[]): SupplyStep[] {
  const firstOpen = steps.findIndex((s) => s.state !== "done");
  return steps.map((s, i) => (s.state === "done" ? s : { ...s, state: i === firstOpen ? "active" : "pending" }));
}

let seq = 0;
export function newStepId(): string {
  seq += 1;
  return `s${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Category colour (stable per category name). */
const PALETTE = ["var(--c-1)", "var(--c-2)", "var(--c-3)", "var(--c-4)", "var(--c-5)"];
export function categoryColor(categories: string[], category: string): string {
  const i = categories.indexOf(category);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length]!;
}
