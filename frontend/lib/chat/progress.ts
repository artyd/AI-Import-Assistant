/**
 * Live progress of one Штурман turn, built from the chat SSE events the
 * contract already has (tool_call · tool_result · token · done): the steps it
 * took, what it is doing now, and a rough time estimate from this browser's
 * past turns. Pure, except the localStorage helpers at the bottom.
 */

export interface TurnStep {
  id: string;
  tool: string;
  label: string;
  startedAt: number;
  endedAt?: number;
}

export interface TurnTrace {
  startedAt: number;
  steps: TurnStep[];
  /** Set when the turn ended (done, error or stopped). */
  endedAt?: number;
}

const q = (input: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What a tool call means to a declarant, in one short Ukrainian line. */
export function stepLabel(tool: string, input: Record<string, unknown> = {}): string {
  switch (tool) {
    case "search_documents": {
      const s = q(input, "query");
      return s ? `Шукаю в документах: «${clip(s, 40)}»` : "Шукаю в документах";
    }
    case "read_file": {
      const f = q(input, "path", "file", "fileName");
      return f ? `Читаю ${clip(f)}` : "Читаю файл";
    }
    case "list_files":
      return "Дивлюся, які файли є";
    case "find_files": {
      const s = q(input, "query");
      return s ? `Шукаю файли: «${clip(s, 40)}»` : "Шукаю файли";
    }
    case "verify_facts":
      return "Перевіряю цифри за документами";
    case "get_checklist":
      return "Перевіряю комплектність пакета";
    case "get_discrepancies":
      return "Звіряю документи між собою";
    case "get_risks":
      return "Оцінюю ризики";
    case "check_drug_registration":
      return "Перевіряю реєстрацію в Держреєстрі";
    case "generate_supplier_instruction":
    case "get_instruction_draft":
    case "propose_instruction_fields":
      return "Готую інструкцію постачальнику";
    case "get_missing_context":
      return "Перевіряю, чого бракує в даних";
    case "save_workspace_context":
      return "Зберігаю дані поставки";
    case "get_contract_mode":
    case "set_contract_mode":
      return "Уточнюю тип контракту";
    case "classify_and_file":
    case "sort_inbox":
    case "normalize_shipment_files":
      return "Розкладаю файли по папках";
    case "generate_report":
      return "Формую звіт";
    case "compare_document_versions":
      return "Порівнюю версії документа";
    case "run_consolidated_analysis":
      return "Аналізую збірник";
    case "list_lots":
    case "get_fcl_overview":
    case "assign_file_to_lot":
      return "Дивлюся партії збірника";
    case "uktzed_lookup_code": {
      const c = q(input, "code");
      return c ? `Митна довідка за кодом ${clip(c, 20)}` : "Митна довідка за кодом";
    }
    case "uktzed_browse_classifier":
      return "Шукаю в класифікаторі УКТ ЗЕД";
    case "dualuse_browse_classifier":
      return "Перевіряю подвійне використання";
    case "get_exchange_rate":
      return "Беру курс НБУ";
    case "pubchem_identify_substance":
      return "Ідентифікую речовину (PubChem)";
    default:
      return `Працюю: ${tool}`;
  }
}

let stepSeq = 0;

export function startStep(t: TurnTrace, tool: string, input: Record<string, unknown>, now: number): TurnTrace {
  const step: TurnStep = { id: `s${++stepSeq}`, tool, label: stepLabel(tool, input), startedAt: now };
  return { ...t, steps: [...t.steps, step] };
}

/** tool_result carries only the tool name: close the oldest open step of that tool. */
export function finishStep(t: TurnTrace, tool: string, now: number): TurnTrace {
  const i = t.steps.findIndex((s) => s.tool === tool && s.endedAt === undefined);
  if (i < 0) return t;
  const steps = t.steps.slice();
  steps[i] = { ...steps[i]!, endedAt: now };
  return { ...t, steps };
}

export function endTrace(t: TurnTrace, now: number): TurnTrace {
  if (t.endedAt !== undefined) return t;
  return { ...t, endedAt: now, steps: t.steps.map((s) => (s.endedAt === undefined ? { ...s, endedAt: now } : s)) };
}

/** What Штурман is doing right now. */
export function currentActivity(t: TurnTrace, writing: boolean): string {
  if (writing) return "Пишу відповідь";
  const open = t.steps.filter((s) => s.endedAt === undefined);
  if (open.length > 1) return `${open[open.length - 1]!.label} (і ще ${open.length - 1})`;
  if (open.length === 1) return open[0]!.label;
  return t.steps.length === 0 ? "Розбираю питання й план перевірки" : "Аналізую знайдене";
}

/** 75 000 → «1:15». */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 18 → «18 с», 95 → «1 хв 35 с». */
export function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} хв ${r} с` : `${m} хв`;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

export interface Estimate {
  /** 0–1 for the bar; null = no history (indeterminate bar). */
  fraction: number | null;
  text: string;
  overdue: boolean;
}

/**
 * Rough «how long is left», from the median of this browser's past turns. It is a
 * guess and says so (≈); past the usual time it says the turn takes longer instead
 * of counting below zero.
 */
export function estimate(elapsedMs: number, pastMs: number[]): Estimate {
  const m = pastMs.length >= 3 ? median(pastMs) : null;
  if (m === null) return { fraction: null, text: "зазвичай 20–60 с", overdue: false };
  if (elapsedMs < m) {
    const left = Math.max(5, Math.ceil((m - elapsedMs) / 5000) * 5);
    return { fraction: Math.min(0.95, elapsedMs / m), text: `≈ ще ${formatSeconds(left)}`, overdue: false };
  }
  return { fraction: 0.95, text: "довше, ніж зазвичай: питання складне", overdue: true };
}

/** Seconds since the last visible event after which the card explains the silence. */
export const QUIET_MS = 45_000;

export function lastEventAt(t: TurnTrace): number {
  return t.steps.reduce((m, s) => Math.max(m, s.startedAt, s.endedAt ?? 0), t.startedAt);
}

// ── Past turn durations (per browser; a convenience, never required) ─────────

const KEY = "shturman.turnDurations";
const KEEP = 20;

export function loadDurations(): number[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is number => typeof x === "number" && x > 0) : [];
  } catch {
    return [];
  }
}

export function recordDuration(ms: number): void {
  if (!(ms > 0)) return;
  try {
    const next = [...loadDurations(), Math.round(ms)].slice(-KEEP);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked — the estimate just stays generic */
  }
}
