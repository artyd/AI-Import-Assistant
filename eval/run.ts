/**
 * Phase-0 golden-set eval runner.
 *
 * Measures the one thing that matters — "the product never lies" — on a labeled
 * set of real shipments:
 *   1. EXTRACTION ACCURACY: per-field, comparing the extraction the pipeline
 *      returns to the fields a pilot declarant hand-verified.
 *   2. DISCREPANCY DETECTION: precision / recall / F1 of the deterministic
 *      reconciliation (`reconcile()`), vs the discrepancies the pilot expects.
 *
 * Two modes (gated so it never spends tokens by accident):
 *   • DRY-RUN (default, and forced whenever ANTHROPIC_API_KEY is unset): scores
 *     against pre-recorded extraction JSON in `eval/fixtures/`. No network, no DB.
 *     This makes the harness itself testable for free.
 *   • REAL (`--real`, requires ANTHROPIC_API_KEY): calls the actual extraction
 *     (`extractDocumentFieldsFromDocument` / `extractDocumentFields`) on each
 *     document's source file/text. Costs money.
 *
 * Discrepancy scoring uses `reconcile()` directly (the pure, DB-free core of
 * `computeDiscrepancies`) so no Postgres is required.
 *
 * Usage:
 *   npm run eval:golden                 # dry-run over eval/golden/*.json
 *   npm run eval:golden -- --real       # real extraction (needs ANTHROPIC_API_KEY)
 *   npm run eval:golden -- --only metopren
 *   EVAL_EXTRACTION_MIN=0.9 EVAL_F1_MIN=0.8 npm run eval:golden
 *
 * Exits non-zero when a threshold is missed, so it can gate CI later.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { reconcile, type Discrepancy, type ReconcileDoc } from '../src/services/reconcile.js';
import type { ExtractedFields } from '../src/services/extraction/extractFields.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const GOLDEN_DIR = join(HERE, 'golden');
const FIXTURES_DIR = join(HERE, 'fixtures');

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

// ── Config / thresholds ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const REAL = args.includes('--real');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx !== -1 ? args[onlyIdx + 1] : undefined;

const EXTRACTION_MIN = Number(process.env.EVAL_EXTRACTION_MIN ?? '0.9');
const F1_MIN = Number(process.env.EVAL_F1_MIN ?? '0.8');
// Numeric fields match within this relative tolerance (weights/values/counts).
const NUM_TOLERANCE = Number(process.env.EVAL_NUM_TOLERANCE ?? '0.01');

// ── Golden-data schema (zod) ──────────────────────────────────────────────────
// `expected` accepts any subset of the labeled fields — the pilot only fills in
// what they verified. `.strict()` catches misspelled field names in golden data.
const expectedFieldsSchema = z
  .object({
    doc_type: z.string(),
    also_contains: z.array(z.string()),
    po_number: z.string().nullable(),
    invoice_number: z.string().nullable(),
    contract_number: z.string().nullable(),
    total_value: z.number().nullable(),
    currency: z.string().nullable(),
    hs_code: z.string().nullable(),
    country_of_origin: z.string().nullable(),
    buyer: z.string().nullable(),
    seller: z.string().nullable(),
    incoterm: z.string().nullable(),
    document_date: z.string().nullable(),
    expiry_date: z.string().nullable(),
    shipment_date: z.string().nullable(),
    delivery_deadline: z.string().nullable(),
    total_weight_kg: z.number().nullable(),
    net_weight_kg: z.number().nullable(),
    gross_weight_kg: z.number().nullable(),
    packages_count: z.number().nullable(),
  })
  .partial()
  .strict();

const sourceSchema = z.union([
  z.object({ file: z.string() }),
  z.object({ text: z.string() }),
]);

const goldenDocSchema = z.object({
  id: z.string(),
  file_name: z.string().optional(),
  source: sourceSchema.optional(),
  // Recorded extraction (relative to eval/fixtures/) used in dry-run mode.
  fixture: z.string().optional(),
  expected: expectedFieldsSchema,
});

const expectedDiscrepancySchema = z.object({
  field: z.string(),
  kind: z.enum(['confirmed', 'suspected']).optional(),
  severity: z.enum(['error', 'warning', 'info']).optional(),
  note: z.string().optional(),
});

const goldenShipmentSchema = z.object({
  shipment_id: z.string(),
  title: z.string().optional(),
  notes: z.string().optional(),
  documents: z.array(goldenDocSchema).min(1),
  expected_discrepancies: z.array(expectedDiscrepancySchema),
});

type GoldenDoc = z.infer<typeof goldenDocSchema>;
type GoldenShipment = z.infer<typeof goldenShipmentSchema>;
type ExpectedFields = z.infer<typeof expectedFieldsSchema>;

// ── Field scoring categories ──────────────────────────────────────────────────
const STRING_EXACT = [
  'doc_type', 'po_number', 'invoice_number', 'contract_number',
  'country_of_origin', 'buyer', 'seller', 'incoterm',
  'document_date', 'expiry_date', 'shipment_date', 'delivery_deadline',
] as const;
const NUMERIC = [
  'total_value', 'total_weight_kg', 'net_weight_kg', 'gross_weight_kg', 'packages_count',
] as const;

type FieldStat = { matched: number; total: number };
const fieldStats = new Map<string, FieldStat>();
function bump(field: string, ok: boolean): void {
  const s = fieldStats.get(field) ?? { matched: 0, total: 0 };
  s.total += 1;
  if (ok) s.matched += 1;
  fieldStats.set(field, s);
}

function normStr(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}
function numMatch(a: number, b: number): boolean {
  const tol = Math.max(Math.abs(a) * NUM_TOLERANCE, 1e-9);
  return Math.abs(a - b) <= tol;
}
function normDigits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** Compare one expected field to the actual extraction; records the per-field stat. */
function scoreField(
  field: string,
  expected: unknown,
  actual: unknown,
): { ok: boolean; expStr: string; actStr: string } {
  let ok: boolean;
  if (field === 'currency') {
    ok = normStr(expected) === normStr(actual);
  } else if (field === 'hs_code') {
    ok = normDigits(expected) === normDigits(actual);
  } else if (field === 'also_contains') {
    const e = new Set((Array.isArray(expected) ? expected : []).map(normStr));
    const a = new Set((Array.isArray(actual) ? actual : []).map(normStr));
    ok = e.size === a.size && [...e].every((x) => a.has(x));
  } else if ((NUMERIC as readonly string[]).includes(field)) {
    ok = typeof expected === 'number' && typeof actual === 'number' && numMatch(expected, actual);
  } else {
    // string-exact (incl. dates), case-insensitive/trimmed.
    ok = normStr(expected) === normStr(actual);
  }
  bump(field, ok);
  return { ok, expStr: fmt(expected), actStr: fmt(actual) };
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  return String(v);
}

// ── Extraction acquisition (dry-run fixture vs real pipeline) ─────────────────
type RealExtractors = {
  extractDocumentFields: (text: string) => Promise<ExtractedFields | null>;
  extractDocumentFieldsFromDocument: (
    buf: Buffer,
    type: import('../src/domain/folders.js').FileType,
    name: string,
  ) => Promise<ExtractedFields | null>;
  extractText: (data: Buffer, type: import('../src/domain/folders.js').FileType) => Promise<{ text: string }[]>;
  inferFileType: (name: string) => import('../src/domain/folders.js').FileType;
};
let realExtractors: RealExtractors | null = null;

async function getRealExtractors(): Promise<RealExtractors> {
  if (realExtractors) return realExtractors;
  // Dynamic import so dry-run never loads config.ts (which exits on a missing key).
  const [extract, ex, folders] = await Promise.all([
    import('../src/services/extraction/extractFields.js'),
    import('../src/services/extract/index.js'),
    import('../src/domain/folders.js'),
  ]);
  realExtractors = {
    extractDocumentFields: extract.extractDocumentFields,
    extractDocumentFieldsFromDocument: extract.extractDocumentFieldsFromDocument,
    extractText: ex.extractText,
    inferFileType: folders.inferFileType,
  };
  return realExtractors;
}

function loadFixture(rel: string): ExtractedFields {
  const p = join(FIXTURES_DIR, rel);
  return JSON.parse(readFileSync(p, 'utf8')) as ExtractedFields;
}

function resolveSourcePath(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

/** Returns the extraction for a document, or null if it can't be obtained. */
async function getExtraction(doc: GoldenDoc): Promise<ExtractedFields | null> {
  if (!REAL) {
    if (!doc.fixture) return null; // no recorded fixture → cannot score in dry-run
    return loadFixture(doc.fixture);
  }
  const src = doc.source;
  if (!src) throw new Error(`doc "${doc.id}" has no "source" — required for --real mode`);
  const ex = await getRealExtractors();
  if ('text' in src) return ex.extractDocumentFields(src.text);
  const path = resolveSourcePath(src.file);
  const buf = readFileSync(path);
  const type = ex.inferFileType(doc.file_name ?? path);
  if (type === 'pdf' || type === 'image') {
    return ex.extractDocumentFieldsFromDocument(buf, type, doc.file_name ?? path);
  }
  const pages = await ex.extractText(buf, type);
  return ex.extractDocumentFields(pages.map((p) => p.text).join('\n\n'));
}

// ── Discrepancy scoring ───────────────────────────────────────────────────────
type DiscTotals = { tp: number; fp: number; fn: number };

function scoreDiscrepancies(
  expected: GoldenShipment['expected_discrepancies'],
  actual: Discrepancy[],
): { totals: DiscTotals; unmatchedExpected: typeof expected; unmatchedActual: Discrepancy[] } {
  const remainingActual = [...actual];
  const unmatchedExpected: typeof expected = [];
  let tp = 0;
  for (const exp of expected) {
    const i = remainingActual.findIndex(
      (a) => a.field === exp.field && (exp.kind === undefined || a.kind === exp.kind),
    );
    if (i !== -1) {
      tp += 1;
      remainingActual.splice(i, 1);
    } else {
      unmatchedExpected.push(exp);
    }
  }
  return {
    totals: { tp, fp: remainingActual.length, fn: unmatchedExpected.length },
    unmatchedExpected,
    unmatchedActual: remainingActual,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────
function loadGolden(): GoldenShipment[] {
  let files: string[];
  try {
    files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch {
    console.error(`${C.r}No golden dir at ${GOLDEN_DIR}${C.x}`);
    process.exit(2);
  }
  const out: GoldenShipment[] = [];
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8'));
    const parsed = goldenShipmentSchema.safeParse(raw);
    if (!parsed.success) {
      console.error(`${C.r}Invalid golden file ${f}:${C.x}`);
      for (const issue of parsed.error.issues) {
        console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(2);
    }
    if (!ONLY || parsed.data.shipment_id === ONLY) out.push(parsed.data);
  }
  return out;
}

async function main(): Promise<void> {
  const mode = REAL ? `${C.y}REAL (billable)${C.x}` : `${C.g}DRY-RUN (fixtures)${C.x}`;
  console.log(`\n${C.b}Golden-set eval${C.x} — mode: ${mode}`);
  if (REAL && !process.env.ANTHROPIC_API_KEY) {
    console.error(`${C.r}--real requires ANTHROPIC_API_KEY.${C.x}`);
    process.exit(2);
  }
  if (!REAL && process.env.ANTHROPIC_API_KEY) {
    console.log(`${C.d}(ANTHROPIC_API_KEY present, but running dry-run; pass --real to spend tokens.)${C.x}`);
  }

  const shipments = loadGolden();
  if (shipments.length === 0) {
    console.error(`${C.r}No golden shipments to run${ONLY ? ` (--only ${ONLY} matched nothing)` : ''}.${C.x}`);
    process.exit(2);
  }

  const discTotal: DiscTotals = { tp: 0, fp: 0, fn: 0 };
  let discSkipped = 0;

  for (const ship of shipments) {
    console.log(`\n${C.c}${C.b}━━ ${ship.shipment_id}${ship.title ? ` · ${ship.title}` : ''} ━━${C.x}`);

    const reconcileDocs: ReconcileDoc[] = [];
    let allExtracted = true;

    for (const doc of ship.documents) {
      const actual = await getExtraction(doc);
      if (!actual) {
        allExtracted = false;
        console.log(`  ${C.y}⚠ ${doc.id}: no extraction (no fixture in dry-run) — fields skipped${C.x}`);
        continue;
      }
      // Score every field the golden entry declared.
      const declared = Object.keys(doc.expected) as (keyof ExpectedFields)[];
      const actualRec = actual as unknown as Record<string, unknown>;
      const misses: string[] = [];
      for (const field of declared) {
        const { ok } = scoreField(field, doc.expected[field], actualRec[field]);
        if (!ok) {
          misses.push(`${field}: expected ${fmt(doc.expected[field])} got ${fmt(actualRec[field])}`);
        }
      }
      const okCount = declared.length - misses.length;
      const color = misses.length === 0 ? C.g : C.y;
      console.log(`  ${color}• ${doc.id}: ${okCount}/${declared.length} fields${C.x}`);
      for (const m of misses) console.log(`      ${C.r}✗ ${m}${C.x}`);

      reconcileDocs.push({
        file_id: doc.id,
        file_name: doc.file_name ?? doc.id,
        doc_type: (actual.doc_type as string | null) ?? null,
        fields: actual as unknown as ReconcileDoc['fields'],
      });
    }

    // Discrepancy scoring needs an extraction for EVERY doc, else FN counts lie.
    if (!allExtracted) {
      discSkipped += 1;
      console.log(`  ${C.d}discrepancy scoring skipped (missing extractions)${C.x}`);
      continue;
    }
    const actualDisc = reconcile(reconcileDocs);
    const { totals, unmatchedExpected, unmatchedActual } = scoreDiscrepancies(
      ship.expected_discrepancies,
      actualDisc,
    );
    discTotal.tp += totals.tp;
    discTotal.fp += totals.fp;
    discTotal.fn += totals.fn;
    console.log(
      `  discrepancies: ${C.g}TP ${totals.tp}${C.x} / ${C.r}FP ${totals.fp}${C.x} / ${C.r}FN ${totals.fn}${C.x}`,
    );
    for (const e of unmatchedExpected) {
      console.log(`      ${C.r}✗ missed (FN): ${e.field}${e.kind ? ` [${e.kind}]` : ''}${C.x}`);
    }
    for (const a of unmatchedActual) {
      console.log(`      ${C.y}! false alarm (FP): ${a.field} [${a.kind}] — ${a.actual}${C.x}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${C.b}── Per-field extraction accuracy ──${C.x}`);
  let matched = 0;
  let total = 0;
  const fields = [...fieldStats.keys()].sort();
  for (const f of fields) {
    const s = fieldStats.get(f)!;
    matched += s.matched;
    total += s.total;
    const pct = s.total ? (s.matched / s.total) * 100 : 0;
    const color = pct >= 100 ? C.g : pct >= 80 ? C.y : C.r;
    console.log(`  ${f.padEnd(20)} ${color}${s.matched}/${s.total} (${pct.toFixed(0)}%)${C.x}`);
  }
  const extractionAcc = total ? matched / total : 0;

  const { tp, fp, fn } = discTotal;
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  console.log(`\n${C.b}── Summary ──${C.x}`);
  console.log(`  extraction accuracy : ${pctColor(extractionAcc, EXTRACTION_MIN)} (${matched}/${total}, min ${(EXTRACTION_MIN * 100).toFixed(0)}%)`);
  console.log(`  discrepancy precision: ${(precision * 100).toFixed(0)}%  recall: ${(recall * 100).toFixed(0)}%`);
  console.log(`  discrepancy F1       : ${pctColor(f1, F1_MIN)} (min ${(F1_MIN * 100).toFixed(0)}%)`);
  if (discSkipped) console.log(`  ${C.y}${discSkipped} shipment(s) skipped discrepancy scoring (missing fixtures)${C.x}`);

  const extractionPass = total === 0 || extractionAcc >= EXTRACTION_MIN;
  const f1Pass = tp + fp + fn === 0 || f1 >= F1_MIN;
  const pass = extractionPass && f1Pass;
  console.log(`\n  ${pass ? `${C.g}${C.b}PASS${C.x}` : `${C.r}${C.b}FAIL${C.x}`}\n`);
  process.exit(pass ? 0 : 1);
}

function pctColor(v: number, min: number): string {
  const color = v >= min ? C.g : C.r;
  return `${color}${(v * 100).toFixed(0)}%${C.x}`;
}

main().catch((err) => {
  console.error(`\n${C.r}Golden eval crashed:${C.x}`, err instanceof Error ? err.message : err);
  process.exit(2);
});
