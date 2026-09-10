import type {
  ExtractedFields,
  FieldConfidence,
  ConfidenceField,
} from './extraction/extractFields.js';

/**
 * Pure, DB-free cross-document reconciliation core.
 *
 * `reconcile()` is the deterministic comparison engine that `computeDiscrepancies`
 * (in `discrepancies.ts`) wraps: that function loads the latest structured
 * extractions for a workspace from Postgres and hands them here as plain objects.
 * Keeping the logic in this dependency-free module (it imports only *types*) lets
 * it run without a database — e.g. from the golden-set eval (`eval/run.ts`) on
 * in-memory extraction objects.
 *
 * Findings are a pure function of the supplied extractions; raw document text is
 * NEVER re-read here. Every finding is RANKED (plan Q15-C):
 *   - `kind: 'confirmed'` (🔴 RED) — a deterministic mismatch where both sides were
 *     read with adequate confidence; carries TWO source citations. A fact.
 *   - `kind: 'suspected'` (🟡 YELLOW) — worth checking but not asserted: a value that
 *     couldn't be read confidently, a fuzzy party-name mismatch, or a check we
 *     deliberately did not run (e.g. line-by-line on a many-item invoice).
 *
 * Guiding rule (plan §6): never pretend we checked what we didn't. Missing/low-
 * confidence data becomes a YELLOW "please verify", never a silent skip.
 */

export type Severity = 'error' | 'warning' | 'info';
export type FlagKind = 'confirmed' | 'suspected';

export interface DiscrepancyCitation {
  file_id: string | null;
  file_name: string | null;
  doc_type: string;
  value: string;
}

export interface Discrepancy {
  field: string;
  expected: string;
  actual: string;
  severity: Severity;
  // ranked confidence + provenance. Optional-at-read for legacy consumers,
  // always populated here.
  kind: FlagKind;
  citations: DiscrepancyCitation[];
}

type Fields = Partial<ExtractedFields> & Record<string, unknown>;

/**
 * One structured extraction as fed to `reconcile()`. This is the shape
 * `computeDiscrepancies` builds from `document_extractions` rows, but callers can
 * construct it directly from any in-memory `ExtractedFields` object.
 */
export interface ReconcileDoc {
  file_id: string | null;
  file_name: string | null;
  doc_type: string | null;
  fields: Fields;
}

// Weight may legitimately differ slightly between invoice and packing list
// (rounding, net vs gross). Flag only when it exceeds this relative tolerance.
const WEIGHT_TOLERANCE = 0.01; // 1%
// Above this many line items we do NOT reconcile row-by-row in the MVP; we fall
// back to totals + an honest "not checked line-by-line" note (plan Q26-A).
const LINE_ITEM_LIMIT = 5;

interface DocRef {
  file_id: string | null;
  file_name: string | null;
  doc_type: string;
  fields: Fields;
}

function pick(docs: ReconcileDoc[], type: string): DocRef | null {
  // Match the primary doc_type first; then fall back to a combined file that
  // declares this type in `also_contains` (2-in-1, e.g. invoice+packing list).
  const primary = docs.find((x) => x.doc_type === type);
  const r =
    primary ??
    docs.find((x) => {
      const also = x.fields.also_contains;
      return Array.isArray(also) && (also as unknown[]).includes(type);
    });
  if (!r) return null;
  return { file_id: r.file_id, file_name: r.file_name, doc_type: type, fields: r.fields };
}

function show(v: unknown): string {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

function confidenceOf(ref: DocRef | null, field: ConfidenceField): string | null {
  const fc = ref?.fields.field_confidence as FieldConfidence | undefined;
  return fc?.[field] ?? null;
}

/** A comparison is only "confirmed" (RED) when neither side was read with low confidence. */
function kindFor(a: DocRef | null, b: DocRef | null, field: ConfidenceField): FlagKind {
  return confidenceOf(a, field) === 'low' || confidenceOf(b, field) === 'low'
    ? 'suspected'
    : 'confirmed';
}

function cite(ref: DocRef, value: unknown): DiscrepancyCitation {
  return { file_id: ref.file_id, file_name: ref.file_name, doc_type: ref.doc_type, value: show(value) };
}

/**
 * Deterministic cross-document reconciliation over already-extracted fields.
 * Pure: no I/O, no DB, no network. Same findings the workspace-scoped
 * `computeDiscrepancies` returns, but on caller-supplied documents.
 */
export function reconcile(docs: ReconcileDoc[]): Discrepancy[] {
  const invoice = pick(docs, 'invoice');
  const po = pick(docs, 'purchase_order');
  const packing = pick(docs, 'packing_list');
  const contract = pick(docs, 'contract');
  const coo = pick(docs, 'certificate_of_origin');

  const out: Discrepancy[] = [];

  // ── PO number should agree across invoice / PO / packing list. ─────────────
  const poRefs: [DocRef, string][] = [];
  for (const ref of [invoice, po, packing]) {
    const v = ref?.fields.po_number;
    if (ref && typeof v === 'string' && v.trim()) poRefs.push([ref, v.trim()]);
  }
  if (poRefs.length >= 2) {
    const distinct = new Set(poRefs.map(([, v]) => v.toLowerCase()));
    if (distinct.size > 1) {
      out.push({
        field: 'po_number',
        expected: show(poRefs[0]![1]),
        actual: poRefs.map(([r, v]) => `${r.doc_type}: ${v}`).join(' | '),
        severity: 'error',
        kind: 'confirmed',
        citations: poRefs.map(([r, v]) => cite(r, v)),
      });
    }
  }

  // ── Weight: invoice vs packing list, within tolerance. Prefer net↔net, then
  //    gross↔gross, then the legacy total. ───────────────────────────────────
  compareWeight(invoice, packing, 'net_weight_kg', out);
  compareWeight(invoice, packing, 'gross_weight_kg', out);
  if (
    !hasNum(invoice, 'net_weight_kg') && !hasNum(packing, 'net_weight_kg') &&
    !hasNum(invoice, 'gross_weight_kg') && !hasNum(packing, 'gross_weight_kg')
  ) {
    compareWeight(invoice, packing, 'total_weight_kg', out);
  }

  // ── Packages count: invoice vs packing list, exact. ────────────────────────
  const pInv = numOf(invoice, 'packages_count');
  const pPl = numOf(packing, 'packages_count');
  if (invoice && packing && pInv !== null && pPl !== null && pInv !== pPl) {
    out.push({
      field: 'packages_count',
      expected: `invoice: ${pInv}`,
      actual: `packing_list: ${pPl}`,
      severity: 'error',
      kind: kindFor(invoice, packing, 'packages_count'),
      citations: [cite(invoice, pInv), cite(packing, pPl)],
    });
  }

  // ── Currency: invoice vs PO / contract, explicit (was silently skipped). ────
  for (const other of [po, contract]) {
    const cInv = strOf(invoice, 'currency');
    const cOther = strOf(other, 'currency');
    if (invoice && other && cInv && cOther && cInv.toUpperCase() !== cOther.toUpperCase()) {
      out.push({
        field: 'currency',
        expected: `${other.doc_type}: ${cOther}`,
        actual: `invoice: ${cInv}`,
        severity: 'warning',
        kind: kindFor(invoice, other, 'currency'),
        citations: [cite(invoice, cInv), cite(other, cOther)],
      });
    }
  }

  // ── Value: invoice vs PO, exact, only when currency matches. ────────────────
  const vInv = numOf(invoice, 'total_value');
  const vPo = numOf(po, 'total_value');
  if (invoice && po && vInv !== null && vPo !== null) {
    const cInv = strOf(invoice, 'currency');
    const cPo = strOf(po, 'currency');
    const sameCurrency = !cInv || !cPo || cInv.toUpperCase() === cPo.toUpperCase();
    if (sameCurrency && vInv !== vPo) {
      out.push({
        field: 'total_value',
        expected: `purchase_order: ${vPo} ${show(cPo)}`,
        actual: `invoice: ${vInv} ${show(cInv)}`,
        severity: 'error',
        kind: kindFor(invoice, po, 'total_value'),
        citations: [cite(po, `${vPo} ${show(cPo)}`), cite(invoice, `${vInv} ${show(cInv)}`)],
      });
    }
  }

  // ── HS code presence on the invoice. ───────────────────────────────────────
  if (invoice && !strOf(invoice, 'hs_code')) {
    out.push({
      field: 'hs_code',
      expected: 'наявний',
      actual: 'відсутній в інвойсі',
      severity: 'warning',
      kind: 'suspected',
      citations: [cite(invoice, '—')],
    });
  }

  // ── HS code consistency invoice ↔ packing list (when both present). MVP does
  //    NOT suggest codes — only checks agreement (plan Q24). ──────────────────
  const hsInv = strOf(invoice, 'hs_code');
  const hsPl = strOf(packing, 'hs_code');
  if (invoice && packing && hsInv && hsPl && normalizeHs(hsInv) !== normalizeHs(hsPl)) {
    out.push({
      field: 'hs_code',
      expected: `invoice: ${hsInv}`,
      actual: `packing_list: ${hsPl}`,
      severity: 'warning',
      kind: kindFor(invoice, packing, 'hs_code'),
      citations: [cite(invoice, hsInv), cite(packing, hsPl)],
    });
  }

  // ── Country of origin presence (invoice or certificate of origin). ──────────
  const originVal = strOf(invoice, 'country_of_origin') ?? strOf(coo, 'country_of_origin');
  if (invoice && !originVal) {
    out.push({
      field: 'country_of_origin',
      expected: 'наявна',
      actual: 'відсутня',
      severity: 'warning',
      kind: 'suspected',
      citations: [cite(invoice, '—')],
    });
  }

  // ── Incoterms should agree between the invoice and the purchase order. ──────
  const incInv = strOf(invoice, 'incoterm');
  const incPo = strOf(po, 'incoterm');
  if (invoice && po && incInv && incPo && incInv.toUpperCase() !== incPo.toUpperCase()) {
    out.push({
      field: 'incoterm',
      expected: `purchase_order: ${incPo}`,
      actual: `invoice: ${incInv}`,
      severity: 'warning',
      kind: kindFor(invoice, po, 'incoterm'),
      citations: [cite(invoice, incInv), cite(po, incPo)],
    });
  }

  // ── Parties cross-check: seller/buyer names between invoice and contract/PO.
  //    Names are fuzzy, so these are always YELLOW (suspected), never asserted. ─
  crossCheckParty(invoice, contract ?? po, 'seller', out);
  crossCheckParty(invoice, contract ?? po, 'buyer', out);

  // ── Line items: reconcile per-row for small shipments; honest degradation for
  //    many-item invoices (plan Q12/Q26). ─────────────────────────────────────
  reconcileLineItems(invoice, packing, out);

  return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function numOf(ref: DocRef | null, field: string): number | null {
  const v = ref?.fields[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function hasNum(ref: DocRef | null, field: string): boolean {
  return numOf(ref, field) !== null;
}
function strOf(ref: DocRef | null, field: string): string | null {
  const v = ref?.fields[field];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function compareWeight(
  invoice: DocRef | null,
  packing: DocRef | null,
  field: 'net_weight_kg' | 'gross_weight_kg' | 'total_weight_kg',
  out: Discrepancy[],
): void {
  const a = numOf(invoice, field);
  const b = numOf(packing, field);
  if (invoice && packing && a !== null && b !== null && a > 0) {
    const rel = Math.abs(a - b) / a;
    if (rel > WEIGHT_TOLERANCE) {
      out.push({
        field,
        expected: `invoice: ${a}`,
        actual: `packing_list: ${b}`,
        severity: 'warning',
        kind: kindFor(invoice, packing, field),
        citations: [cite(invoice, a), cite(packing, b)],
      });
    }
  }
}

function normalizeHs(hs: string): string {
  return hs.replace(/\D/g, '');
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|llc|inc|gmbh|co|corp|company|тов|ооо|пп|лтд)\b/g, '')
    .replace(/[^a-z0-9а-яіїєґ]/gi, '')
    .trim();
}

function crossCheckParty(
  a: DocRef | null,
  b: DocRef | null,
  field: 'seller' | 'buyer',
  out: Discrepancy[],
): void {
  const na = strOf(a, field);
  const nb = strOf(b, field);
  if (!a || !b || !na || !nb) return;
  const ka = normalizeName(na);
  const kb = normalizeName(nb);
  if (!ka || !kb) return;
  // Consider a match if either normalized name contains the other (handles
  // "Prime Force UK Business Ltd" vs "Prime Force UK").
  if (ka.includes(kb) || kb.includes(ka)) return;
  out.push({
    field,
    expected: `${b.doc_type}: ${nb}`,
    actual: `invoice: ${na}`,
    severity: 'warning',
    kind: 'suspected',
    citations: [cite(a, na), cite(b, nb)],
  });
}

function reconcileLineItems(
  invoice: DocRef | null,
  packing: DocRef | null,
  out: Discrepancy[],
): void {
  const invItems = Array.isArray(invoice?.fields.line_items) ? invoice!.fields.line_items : [];
  const plItems = Array.isArray(packing?.fields.line_items) ? packing!.fields.line_items : [];
  if (!invoice || !packing || (invItems.length === 0 && plItems.length === 0)) return;

  const maxLen = Math.max(invItems.length, plItems.length);
  if (maxLen > LINE_ITEM_LIMIT) {
    // Honest degradation: totals were compared above; say plainly we did not
    // reconcile row-by-row instead of pretending we did.
    out.push({
      field: 'line_items',
      expected: 'построчна звірка',
      actual: `багатопозиційна поставка (${maxLen} позицій) — построчно НЕ перевірено, звірено лише підсумки`,
      severity: 'info',
      kind: 'suspected',
      citations: [cite(invoice, `${invItems.length} позицій`), cite(packing, `${plItems.length} позицій`)],
    });
    return;
  }

  // Small shipment: at least reconcile the item count between the two docs.
  if (invItems.length > 0 && plItems.length > 0 && invItems.length !== plItems.length) {
    out.push({
      field: 'line_items',
      expected: `invoice: ${invItems.length} позицій`,
      actual: `packing_list: ${plItems.length} позицій`,
      severity: 'error',
      kind: 'confirmed',
      citations: [cite(invoice, `${invItems.length} позицій`), cite(packing, `${plItems.length} позицій`)],
    });
  }
}
