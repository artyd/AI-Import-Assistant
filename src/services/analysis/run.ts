import { analyzeDeterministic } from './pipeline/deterministic.js';
import { parseWorkbook, parseCSV } from './sheets/parse.js';
import type { SheetInput } from './sheets/selectActualSheet.js';
import { normalize } from './engines/classify.js';
import { enrichWithAi, type AiEnrichInputItem } from './ai.js';
// Type-only (erased at build) so the enrichment module — which pulls in config —
// is loaded lazily, only when the integration is actually on (see below).
import type { SourceCheck } from './sourceCheck.js';

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
  /** true when `code` was proposed by the engine (dict/HS-match/AI), not taken
   *  verbatim from the manifest — so the UI can label it «запропоновано». */
  codeSuggested: boolean;
  /** Why this code was proposed (official HS description / AI reasoning) — shown
   *  next to a suggested code, per the "advisory, with reasoning" grounding rule. */
  codeBasis: string | null;
  /** For a SUGGESTED code: true when qdpro (першоджерело) confirmed the code
   *  exists. null when not applicable (firm code) or the check didn't run. */
  codeVerified: boolean | null;
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
  // Live cross-check with the official source (qdpro via logist-mcp). null when the
  // integration is off or the code couldn't be checked. Enrichment only — it never
  // alters cif/duty/vat above.
  sourceCheck?: SourceCheck | null;
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
  /** true when live source cross-check (qdpro via logist-mcp) ran for ≥1 code. */
  sourceChecked: boolean;
  /** false when the manifest had no price/quantity data (customs value 0 across
   *  all lines) — the analysis is then classification-only (codes + checks), and
   *  the money figures must NOT be presented as a real cost calculation. */
  costDataAvailable: boolean;
  /** Official NBU rate (UAH per 1 unit of the shipment currency) so the money
   *  figures can also be shown in гривні — customs value is declared in UAH. null
   *  when the rate service is off or unavailable. */
  fx: { currency: string; rate: number; date: string } | null;
}

export type AnalysisInput =
  | { kind: 'file'; buffer: Buffer | Uint8Array; filename: string }
  | { kind: 'sheetUrl'; url: string }
  | { kind: 'text'; text: string };

/** Real-progress signal for the streaming analyze endpoint (0–100 + a comment). */
export interface AnalysisProgress {
  pct: number;
  step: string;
}
export type ProgressFn = (p: AnalysisProgress) => void;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Digits-only УКТЗЕД code of a plausible length (HS-6 … 10-digit), else null. */
function sanitizeCode(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  return [6, 8, 10].includes(d.length) ? d : null;
}

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

/**
 * @param ownerId  when set, the AI enrichment step routes through that user's
 *   BYOK provider (falling back to built-in Claude); omitted → always built-in.
 */
export async function runAnalysis(
  input: AnalysisInput,
  ownerId?: string,
  onProgress?: ProgressFn,
): Promise<AnalysisResult> {
  const progress: ProgressFn = (p) => {
    try {
      onProgress?.(p);
    } catch {
      /* progress reporting must never break the analysis */
    }
  };

  progress({ pct: 4, step: 'Отримую маніфест…' });
  const { sheets, source } = await resolveSheets(input);

  progress({ pct: 14, step: 'Обираю актуальний лист…' });
  const det = analyzeDeterministic(sheets, DEFAULT_SHIPMENT, new Date());
  progress({ pct: 30, step: `Розраховано CIF / мито / ПДВ по ${det.lines.length} позиціях…` });

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

  if (aiInput.length > 0) progress({ pct: 34, step: 'AI-перевірки позицій…' });
  const enrichment = await enrichWithAi(aiInput, ownerId, (done, total) =>
    progress({ pct: 34 + Math.round((32 * done) / total), step: `AI-перевірки позицій (${done}/${total})…` }),
  );

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
      // Prefer the resolver's code; when it found none, fall back to the AI's
      // proposal so empty «—» codes get an advisory candidate (verified against
      // qdpro below). AI codes are sanitised to plausible УКТЗЕД digit lengths.
      code: l.resolved.code.value ?? sanitizeCode(ai?.suggestedUctzedCode),
      // Suggested when the code did not come verbatim from the manifest cell.
      codeSuggested: !(l.resolved.code.source === 'user' && l.resolved.code.value != null)
        && (l.resolved.code.value ?? sanitizeCode(ai?.suggestedUctzedCode)) != null,
      codeBasis: l.resolved.hsDescription
        ?? (l.resolved.code.value == null ? (ai?.codeBasis?.trim() || null) : null),
      codeVerified: null,
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
      sourceCheck: null,
    };
  });

  // Live source cross-check (enrichment only — never changes the numbers above).
  // Best-effort: gated on LOGIST_MCP_URL, tolerates failures, one fetch per unique
  // code. The env guard + dynamic import keep the config-loading logist module out
  // of code paths (and tests) where the integration is off.
  let sourceChecked = false;
  if (process.env.LOGIST_MCP_URL && process.env.LOGIST_MCP_URL.trim()) {
    try {
      const { fetchImportChecks, lookupCheck, toSourceCheck } = await import('./sourceCheck.js');
      progress({ pct: 70, step: 'Звіряю коди з qdpro (першоджерело)…' });
      const checks = await fetchImportChecks(rows.map((r) => r.code), (done, total) =>
        progress({ pct: 70 + Math.round((24 * done) / total), step: `Звіряю коди з qdpro (${done}/${total})…` }),
      );
      if (checks.size > 0) {
        sourceChecked = true;
        for (const r of rows) {
          const raw = lookupCheck(checks, r.code);
          // A suggested code is "verified" only if qdpro actually knows it.
          if (r.codeSuggested) r.codeVerified = raw != null;
          if (!raw) continue;
          r.sourceCheck = toSourceCheck(raw, r.dutyRate);
          // qdpro is authoritative: if its duty rate diverges from the static
          // table used in the calc, flag the position for the human to verify.
          if (r.sourceCheck.dutyMismatch) r.needsReview = true;
        }
      }
    } catch {
      /* enrichment is optional — keep the full analysis */
    }
  }

  progress({ pct: 96, step: 'Формую результат…' });
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

  // No customs value anywhere ⇒ the manifest carried no price/qty columns (or all
  // zeros): this is a classification-only analysis, not a cost calculation.
  const costDataAvailable = totals.cif > 0;

  // Live NBU rate so the money can also be shown in гривні (customs value is
  // declared in UAH). Best-effort: gated on LOGIST_MCP_URL, tolerates failure.
  let fx: AnalysisResult['fx'] = null;
  if (costDataAvailable && process.env.LOGIST_MCP_URL && process.env.LOGIST_MCP_URL.trim()) {
    try {
      progress({ pct: 94, step: 'Отримую курс НБУ…' });
      const { exchangeRate } = await import('../logist/index.js');
      const r = await exchangeRate(DEFAULT_SHIPMENT.currency, '');
      if (r && typeof r.rate === 'number' && r.rate > 0) {
        fx = { currency: DEFAULT_SHIPMENT.currency, rate: r.rate, date: r.date || '' };
      }
    } catch {
      /* fx is optional — keep the analysis without UAH figures */
    }
  }

  let warnings = [...det.warnings];
  if (enrichment.degraded) {
    warnings.unshift('AI-перевірки недоступні — показано лише детермінований розрахунок; позиції позначено «перевірити».');
  }
  if (!costDataAvailable) {
    warnings.unshift('У маніфесті не знайдено колонок ціни/кількості — розрахунок платежів неможливий. Показано класифікацію (коди + перевірки).');
  }
  // The NBU rate closes the "no UAH rate" gap — drop that deterministic warning.
  if (fx) warnings = warnings.filter((w) => !/курс до uah/i.test(w));

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
    sourceChecked,
    costDataAvailable,
    fx,
  };
}
