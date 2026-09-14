import { analyzeDeterministic } from './pipeline/deterministic.js';
import { parseWorkbook, parseCSV } from './sheets/parse.js';
import type { SheetInput } from './sheets/selectActualSheet.js';
import { normalize } from './engines/classify.js';
import { enrichWithAi, type AiEnrichInputItem } from './ai.js';

/**
 * B-2 orchestration: turn a manifest (uploaded file / Google Sheets link / pasted
 * table) into the consolidated `AnalysisResult` the frontend card renders.
 *
 * Pipeline: parse → selectActualSheet (inside analyzeDeterministic) → deterministic
 * resolve+payments (CIF / мито / ПДВ, origin options, EU/UA category checks) → AI
 * enrichment (descriptive/classification fields only, batched) → assemble.
 *
 * The product_origin_kb is applied BEFORE the AI (inside `resolveLine`): a confident
 * KB origin match is authoritative and is NOT overwritten by the model's guess.
 *
 * This module does NOT persist — the route/agent-tool owns the DB writes.
 */

// ── Public result shape (the frontend analysis card depends on these EXACT fields) ──
export interface AnalysisCheck {
  item: string;
  status: string; // 'green' | 'yellow' | 'red' (kept a string — models are loose)
  note: string;
}

export interface AnalysisRow {
  name: string;
  code: string | null;
  qtyKg: number;
  price: number; // per-kg, in shipment currency
  dutyRate: number | null; // %
  category: string;
  origin: string | null; // origin type (KB-confident, else AI)
  risk: string | null; // 'Критичний' | 'Середній' | 'Низький' | null
  riskNote: string;
  cif: number; // customs value
  duty: number | null;
  vat: number | null;
  eu: AnalysisCheck[];
  ua: AnalysisCheck[];
  needsReview: boolean;
}

export interface AnalysisTotals {
  cif: number;
  duty: number;
  vat: number;
  payable: number;
  count: number;
}

export interface AnalysisMeta {
  sheet: string;
  date: string | null;
  reason: string;
  ignored: string[];
}

export interface AnalysisResult {
  /** Set once persisted (null from `runAnalysis`; filled by the route/tool). */
  id: string | null;
  meta: AnalysisMeta;
  rows: AnalysisRow[];
  totals: AnalysisTotals;
  source: string; // manifest source label
  sheet: string; // selected sheet name (mirror of meta.sheet, convenience)
  criticalAlert: string;
  nctsList: string[];
  warnings: string[];
  /** true when any item is high-risk (Критичний) or carries a red check. */
  hasHigh: boolean;
  /** true when AI enrichment was unavailable/failed (rows are deterministic-only). */
  aiDegraded: boolean;
}

export type AnalysisInput =
  | { kind: 'file'; buffer: Buffer | Uint8Array; filename: string }
  | { kind: 'sheetUrl'; url: string }
  | { kind: 'text'; text: string };

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Default shipment assumptions (CIF/USD → freight+insurance already in price). */
const DEFAULT_SHIPMENT = {
  incoterm: 'CIF',
  currency: 'USD',
  freight: null,
  insurance: null,
  fxToUAH: null,
  fxDate: null,
} as const;

function googleSheetsCsvUrl(url: string): string | null {
  const id = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
  if (!id) return null;
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

/** Resolves the raw manifest input into parsed sheets + a human source label. */
async function resolveSheets(input: AnalysisInput): Promise<{ sheets: SheetInput[]; source: string }> {
  if (input.kind === 'file') {
    const buf = input.buffer instanceof Uint8Array ? input.buffer : new Uint8Array(input.buffer);
    return { sheets: parseWorkbook(buf, input.filename), source: input.filename };
  }
  if (input.kind === 'sheetUrl') {
    const csvUrl = googleSheetsCsvUrl(input.url);
    if (!csvUrl) throw new Error('Не схоже на посилання Google Sheets.');
    const res = await fetch(csvUrl);
    if (!res.ok) {
      throw new Error(
        `Не вдалося завантажити таблицю (HTTP ${res.status}). Переконайтесь, що доступ «Усі з посиланням».`,
      );
    }
    const text = await res.text();
    return { sheets: [{ name: 'Google Sheets', rows: parseCSV(text) }], source: 'Google Sheets' };
  }
  // kind === 'text' — pasted CSV/TSV table.
  if (!input.text.trim()) throw new Error('Порожня таблиця.');
  return { sheets: [{ name: 'Вставлена таблиця', rows: parseCSV(input.text) }], source: 'Вставлена таблиця' };
}

export async function runAnalysis(input: AnalysisInput): Promise<AnalysisResult> {
  const { sheets, source } = await resolveSheets(input);

  const det = analyzeDeterministic(sheets, DEFAULT_SHIPMENT, new Date());

  // AI enrichment input, pre-grounded by the deterministic engine + KB.
  const aiInput: AiEnrichInputItem[] = det.lines.map((l) => {
    const rec = l.originOptions.find((o) => o.recommended) ?? l.originOptions[0];
    return {
      name: l.calc.name,
      uctzedCode: l.resolved.code.value,
      codeConfidence: l.resolved.code.confidence ?? 'low',
      dutyRatePercent: l.calc.dutyRatePercent?.value ?? null,
      dutyRateSource: l.resolved.code.source,
      originType: l.resolved.origin?.originType ?? null,
      recommendedOrigin: rec ? `${rec.shortLabel} (впевненість ${rec.confidence})` : null,
      category: l.resolved.origin?.category ?? '',
      precursorNote: l.resolved.precursor?.note ?? null,
    };
  });

  const enrichment = await enrichWithAi(aiInput);

  const rows: AnalysisRow[] = det.lines.map((l) => {
    const rec = l.originOptions.find((o) => o.recommended) ?? l.originOptions[0];
    const ai = enrichment.byName.get(normalize(l.calc.name));

    // KB (product_origin_kb) origin, applied before AI, wins over the model's guess.
    const kbOrigin = l.resolved.origin?.originType ?? null;
    const origin = kbOrigin ?? ai?.originType ?? rec?.label ?? null;
    const category = l.resolved.origin?.category || ai?.category || '';

    // EU/UA checks: origin engine's recommended profile + category checks + AI checks.
    const eu: AnalysisCheck[] = [
      ...(rec?.euChecks ?? []),
      ...l.appChecks.eu,
      ...(ai?.euChecks ?? []),
    ];
    const ua: AnalysisCheck[] = [
      ...(rec?.uaChecks ?? []),
      ...l.appChecks.ua,
      ...(ai?.uaChecks ?? []),
    ];

    // Deterministic needsReview (from payment.ts) OR AI needsReview OR AI degraded.
    const needsReview = l.calc.needsReview || (ai?.needsReview ?? enrichment.degraded);

    return {
      name: l.calc.name,
      code: l.resolved.code.value,
      qtyKg: l.calc.qtyKg,
      price: round2(l.calc.goodsValue.value / (l.calc.qtyKg || 1)),
      dutyRate: l.calc.dutyRatePercent?.value ?? null,
      category,
      origin,
      risk: ai?.risk ?? null,
      riskNote: ai?.riskNote ?? '',
      cif: l.calc.customsValue.value,
      duty: l.calc.duty?.value ?? null,
      vat: l.calc.vat?.value ?? null,
      eu,
      ua,
      needsReview,
    };
  });

  const s = det.calc.summary;
  const totals: AnalysisTotals = {
    cif: s.totalCustomsValue.value,
    duty: s.totalDuty.value,
    vat: s.totalVAT.value,
    payable: s.totalPayable.value,
    count: rows.length,
  };

  const hasHigh = rows.some(
    (r) => r.risk === 'Критичний' || r.eu.some((c) => c.status === 'red') || r.ua.some((c) => c.status === 'red'),
  );

  const warnings = [...det.warnings];
  if (enrichment.degraded) {
    warnings.unshift('AI-перевірки недоступні — показано лише детермінований розрахунок; позиції позначено «перевірити».');
  }

  return {
    id: null,
    meta: { sheet: det.selectedSheetName, date: det.selectedSheetDate, reason: det.reason, ignored: det.ignored },
    rows,
    totals,
    source,
    sheet: det.selectedSheetName,
    criticalAlert: enrichment.criticalAlert,
    nctsList: enrichment.nctsList,
    warnings,
    hasHigh,
    aiDegraded: enrichment.degraded,
  };
}
