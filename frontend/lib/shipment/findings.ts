// Display logic for verdict findings (discrepancies and risks): what counts as a
// problem, what is only a note, and how a finding reads to the user. Pure — the
// components only render what comes out of here.
//
//   severity error|warning  → a problem   (kind "suspected" → «перевірити», not a fact)
//   severity info           → a note      (what was or wasn't compared; never a problem)

import type { Discrepancy, DiscrepancyCitation } from "@/lib/types";
import { FIELD_LABEL, REQ_LABEL } from "@/components/shipment/labels";

export type Severity = "error" | "warning" | "info";
export type FindingClass = "problem" | "check" | "note";
export type Tone = "ok" | "warn" | "err";

interface Classifiable {
  severity: Severity;
  kind?: "confirmed" | "suspected";
  /** The user's decision (spec 011): a triaged finding is not counted. */
  triage?: unknown;
}

/** note = info; check = suspected error/warning; problem = confirmed error/warning. */
export function classifyFinding(f: Classifiable): FindingClass {
  if (f.severity === "info") return "note";
  return f.kind === "suspected" ? "check" : "problem";
}

export interface FindingSummary {
  /** Confirmed errors (red). */
  errors: number;
  /** Confirmed warnings (amber). */
  warnings: number;
  /** Suspected errors/warnings: «перевірити». */
  toCheck: number;
  /** Info notes — muted, never counted as problems. */
  notes: number;
  /** Triaged («Не проблема» / «Вирішено») — left out of every other number. */
  decided: number;
  /** errors + warnings + toCheck. */
  problems: number;
  /** Red only for a confirmed error; amber for any other problem; green otherwise. */
  tone: Tone;
}

export function summarizeFindings(items: Classifiable[]): FindingSummary {
  let errors = 0;
  let warnings = 0;
  let toCheck = 0;
  let notes = 0;
  let decided = 0;
  for (const f of items) {
    if (f.triage) {
      decided++;
      continue;
    }
    const c = classifyFinding(f);
    if (c === "note") notes++;
    else if (c === "check") toCheck++;
    else if (f.severity === "error") errors++;
    else warnings++;
  }
  const problems = errors + warnings + toCheck;
  return { errors, warnings, toCheck, notes, decided, problems, tone: errors > 0 ? "err" : problems > 0 ? "warn" : "ok" };
}

export interface FindingGroups<T> {
  problems: T[];
  check: T[];
  notes: T[];
  /** Triaged by the user — «Розібрано (N)». */
  decided: T[];
}

/** Problems first (errors before warnings), then «перевірити», then notes. */
export function groupFindings<T extends Classifiable>(items: T[]): FindingGroups<T> {
  const rank = (f: T) => (f.severity === "error" ? 0 : 1);
  const out: FindingGroups<T> = { problems: [], check: [], notes: [], decided: [] };
  for (const f of items) {
    if (f.triage) {
      out.decided.push(f);
      continue;
    }
    const c = classifyFinding(f);
    (c === "note" ? out.notes : c === "check" ? out.check : out.problems).push(f);
  }
  out.problems.sort((a, b) => rank(a) - rank(b));
  return out;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** «2 проблеми · 1 перевірити · 5 приміток» — empty parts are left out. */
export function summaryText(s: Pick<FindingSummary, "problems" | "toCheck" | "notes">): string {
  const confirmed = s.problems - s.toCheck;
  const parts: string[] = [];
  if (confirmed > 0) parts.push(`${confirmed} ${plural(confirmed, "проблема", "проблеми", "проблем")}`);
  if (s.toCheck > 0) parts.push(`${s.toCheck} перевірити`);
  if (s.notes > 0) parts.push(`${s.notes} ${plural(s.notes, "примітка", "примітки", "приміток")}`);
  return parts.join(" · ");
}

// ── Labels: nothing raw reaches the user ──────────────────────────────────────

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** A machine key: latin snake_case / colon-separated, no spaces. */
const RAW_KEY = /^[a-z0-9_.:-]+$/i;

const EXTRA_FIELD_LABEL: Record<string, string> = {
  lot_packages_count: "Кількість місць партії",
  lot_net_weight_kg: "Вага нетто партії",
  lot_total_value: "Сума партії",
  lot_name: "Назва партії",
  lot_consignee: "Одержувач партії",
  transit_packages_count: "Кількість місць T1 проти MBL",
  invoice_number: "№ інвойсу",
  contract_number: "№ контракту",
  po_number: "№ замовлення",
};

/** A reconciliation field key → human Ukrainian. Unknown machine keys never show raw. */
export function fieldLabel(field: string): string {
  if (FIELD_LABEL[field]) return FIELD_LABEL[field]!;
  if (EXTRA_FIELD_LABEL[field]) return EXTRA_FIELD_LABEL[field]!;
  if (field.startsWith("customs_declaration:")) return `Митна декларація — ${field.slice("customs_declaration:".length)}`;
  if (/^hbl:/i.test(field)) return "House-коносамент (HBL)";
  const v = /^hbl_versions_(.+)$/.exec(field);
  if (v) return `Копії HBL: ${fieldLabel(v[1]!).toLowerCase()}`;
  const lot = /^lot_(.+)$/.exec(field);
  if (lot) return `Партія: ${fieldLabel(lot[1]!).toLowerCase()}`;
  if (UUID.test(field) || RAW_KEY.test(field)) return "Інший показник";
  return field;
}

const EXTRA_REQ_LABEL: Record<string, string> = {
  manifest: "Маніфест збірника",
  transit: "Транзитна декларація T1 / NCTS",
  hbl: "House-коносамент (HBL)",
  mbl: "Master-коносамент (MBL)",
  awb: "Авіанакладна (AWB)",
  other: "Інший документ",
};

/** A checklist requirement key → human Ukrainian (handles `customs_declaration:<name>`, `hbl:<uuid>`). */
export function requirementLabel(key: string): string {
  if (REQ_LABEL[key]) return REQ_LABEL[key]!;
  if (EXTRA_REQ_LABEL[key]) return EXTRA_REQ_LABEL[key]!;
  if (key.startsWith("customs_declaration:")) return `Митна декларація — ${key.slice("customs_declaration:".length)}`;
  if (/^hbl:/i.test(key)) return "House-коносамент (HBL)";
  if (/^lot[:_]/i.test(key) || UUID.test(key) || RAW_KEY.test(key)) return "Інший документ";
  return key;
}

const DOC_TYPE_LABEL: Record<string, string> = {
  invoice: "Інвойс",
  packing_list: "Пакувальний лист",
  contract: "Контракт",
  certificate_of_origin: "Сертифікат походження",
  quality_certificate: "Сертифікат якості",
  customs_declaration: "Митна декларація",
  transport: "Транспортний документ",
  other: "Документ",
};

export function docTypeLabel(t: string): string {
  return DOC_TYPE_LABEL[t] ?? EXTRA_REQ_LABEL[t] ?? REQ_LABEL[t] ?? (RAW_KEY.test(t) ? "Документ" : t);
}

/** Strip internal markers that may sit inside value text («[suspected]», raw ids). */
export function cleanText(s: string): string {
  return s
    .replace(/\[(suspected|confirmed|error|warning|info)\]/gi, "")
    .replace(new RegExp(UUID.source, "gi"), "…")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Shorten long text to `max` characters with an ellipsis. */
export function truncate(s: string, max = 90): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The first `limit` distinct file names and how many more there are. */
export function fileList(citations: DiscrepancyCitation[] | undefined, limit = 2): { shown: string[]; more: number } {
  const names = [...new Set((citations ?? []).map((c) => c.file_name).filter((n): n is string => !!n))];
  return { shown: names.slice(0, limit), more: Math.max(0, names.length - limit) };
}

/** «a.pdf», «b.pdf» +3 */
export function filesText(citations: DiscrepancyCitation[] | undefined, limit = 2): string {
  const { shown, more } = fileList(citations, limit);
  if (shown.length === 0) return "";
  return `${shown.map((n) => `«${truncate(n, 40)}»`).join(", ")}${more > 0 ? ` +${more}` : ""}`;
}

export interface FindingView {
  /** What: the human field name. */
  title: string;
  /** The lot the finding belongs to (Збірник), if any. */
  lot: string | null;
  /** Values: «expected → actual», compact. */
  values: string;
  /** Where: the files behind it, truncated with «+N». */
  files: string;
  cls: FindingClass;
}

export function findingView(d: Discrepancy & { lot?: string }): FindingView {
  const expected = truncate(cleanText(d.expected ?? ""), 80);
  const actual = truncate(cleanText(d.actual ?? ""), 80);
  const values = expected && actual ? `${expected} → ${actual}` : expected || actual;
  return { title: fieldLabel(d.field), lot: d.lot ?? null, values, files: filesText(d.citations), cls: classifyFinding(d) };
}

/** Human text for a failed request: never a raw error code. */
export function requestErrorText(code?: string): string {
  switch (code) {
    case "unauthorized":
    case "unauthenticated":
      return "Сесію завершено — увійдіть знову.";
    case "not_found":
      return "Поставку не знайдено.";
    case "rate_limited":
      return "Забагато запитів — спробуйте за хвилину.";
    default:
      return "Не вдалося виконати запит. Спробуйте ще раз.";
  }
}

/**
 * A manual status that promises readiness while problems exist reads as a
 * contradiction; returns the caveat to show next to the status, or null.
 */
export function statusCaveat(status: string, s: Pick<FindingSummary, "errors" | "warnings" | "toCheck">): string | null {
  const ready = status === "customs_ready" || status === "done" || status === "docs_complete";
  if (!ready) return null;
  const confirmed = s.errors + s.warnings;
  if (confirmed > 0) return `Є ${confirmed} ${plural(confirmed, "проблема", "проблеми", "проблем")} — перегляньте перед митницею.`;
  if (s.toCheck > 0) return `Є пункти «перевірити» (${s.toCheck}) — перегляньте перед митницею.`;
  return null;
}
