import type {
  ExtractedFields,
  ExtractedLineItem,
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
// Monetary values may differ by rounding across documents; flag only a gap
// beyond this relative tolerance so a 1-cent difference isn't a red error.
const VALUE_TOLERANCE = 0.005; // 0.5%
// Above this many line items we do NOT reconcile row-by-row in the MVP; we fall
// back to totals + an honest "not checked line-by-line" note (plan Q26-A).
const LINE_ITEM_LIMIT = 5;

interface DocRef {
  file_id: string | null;
  file_name: string | null;
  doc_type: string;
  fields: Fields;
}

/**
 * Editable office formats (.doc/.docx/.xls/.xlsx/.csv/.md) are usually the
 * drafts a supplier sends for approval; the issued document is the PDF/scan.
 * When several files share a doc_type, prefer the issued one.
 */
const DRAFT_EXT_RX = /\.(docx?|xlsx?|csv|md|txt)$/i;
export function isLikelyDraft(fileName: string | null): boolean {
  return !!fileName && DRAFT_EXT_RX.test(fileName.trim());
}

/** Stable preference order among same-type docs: issued (PDF/scan) before drafts, then input order. */
function preferIssued<T extends { file_name: string | null }>(list: T[]): T[] {
  return list
    .map((d, i) => ({ d, i }))
    .sort((a, b) => Number(isLikelyDraft(a.d.file_name)) - Number(isLikelyDraft(b.d.file_name)) || a.i - b.i)
    .map((x) => x.d);
}

function pick(docs: ReconcileDoc[], type: string): DocRef | null {
  // Match the primary doc_type first; then fall back to a combined file that
  // declares this type in `also_contains` (2-in-1, e.g. invoice+packing list).
  const primary = preferIssued(docs.filter((x) => x.doc_type === type))[0];
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

/** Optional shipment context that switches on the trilateral (3-party) checks. */
export interface ReconcileOptions {
  /** Contract structure. 'trilateral' enables the two-leg invoice checks below. */
  contractMode?: 'bilateral' | 'trilateral' | null;
  /** Buy-side (Постачальник→Prime) Incoterm — checked against the inbound leg. */
  incotermIn?: string | null;
  /** Sell-side (Prime→AGroup95) Incoterm (outbound leg is checked vs the contract). */
  incotermOut?: string | null;
  /** The intermediary's name from the parties card — orients the invoice legs. */
  intermediaryName?: string | null;
}

/**
 * Deterministic cross-document reconciliation over already-extracted fields.
 * Pure: no I/O, no DB, no network. Same findings the workspace-scoped
 * `computeDiscrepancies` returns, but on caller-supplied documents.
 *
 * Bilateral (default) keeps the single-invoice logic. Trilateral (3-party) adds
 * two-leg handling: it treats two invoices as EXPECTED (not a duplicate), checks
 * the OUTBOUND leg (Prime→AGroup95) against the contract, treats the value gap
 * between legs as expected markup, and verifies physical goods + intermediary
 * orientation across the legs. See `reconcileTrilateral`.
 */
export function reconcile(docs: ReconcileDoc[], opts: ReconcileOptions = {}): Discrepancy[] {
  const trilateral = opts.contractMode === 'trilateral';
  const packing = pick(docs, 'packing_list');
  const contract = pick(docs, 'contract');
  const coo = pick(docs, 'certificate_of_origin');

  // Invoice selection. Bilateral: the single invoice. Trilateral: the OUTBOUND
  // leg (Prime→AGroup95) is what the contract / value / Incoterms are checked
  // against; the inbound leg (Supplier→Prime) legitimately differs in price and
  // is reconciled separately (markup + physical consistency).
  const invoiceRefs = preferIssued(docs.filter((d) => d.doc_type === 'invoice')).map(toRef);
  const legOf = (i: DocRef) => classifyInvoiceLeg(i, opts.intermediaryName ?? null);
  const outbound = trilateral ? invoiceRefs.find((i) => legOf(i) === 'outbound') ?? null : null;
  const inbound = trilateral ? invoiceRefs.find((i) => legOf(i) === 'inbound') ?? null : null;
  const invoice = trilateral ? outbound ?? pick(docs, 'invoice') : pick(docs, 'invoice');

  const out: Discrepancy[] = [];

  // NB: these supplies have no separate purchase order — the CONTRACT is the
  // commercial reference the invoice is checked against (value / currency /
  // Incoterms).

  // ── Weight & packages: net / gross / places must agree across EVERY document
  //    that states them (invoices, packing lists, AWB/CMR/T1, МД, COO) — the
  //    transport and customs documents are where a rounded 31.85→32 kg or a
  //    T1 "net = gross" slip shows up. Legacy total stays invoice↔packing. ───
  checkPhysicalConsistency(docs, 'net_weight_kg', out);
  checkPhysicalConsistency(docs, 'gross_weight_kg', out);
  if (
    !hasNum(invoice, 'net_weight_kg') && !hasNum(packing, 'net_weight_kg') &&
    !hasNum(invoice, 'gross_weight_kg') && !hasNum(packing, 'gross_weight_kg')
  ) {
    compareWeight(invoice, packing, 'total_weight_kg', out);
  }

  // ── Packages count: exact, across every document that states it. ─────────
  checkPhysicalConsistency(docs, 'packages_count', out);

  // ── Currency: invoice vs contract, explicit. ───────────────────────────────
  {
    const cInv = strOf(invoice, 'currency');
    const cC = strOf(contract, 'currency');
    if (invoice && contract && cInv && cC && cInv.toUpperCase() !== cC.toUpperCase()) {
      out.push({
        field: 'currency',
        expected: `contract: ${cC}`,
        actual: `invoice: ${cInv}`,
        severity: 'warning',
        kind: kindFor(invoice, contract, 'currency'),
        citations: [cite(invoice, cInv), cite(contract, cC)],
      });
    }
  }

  // ── Value: invoice vs contract, within tolerance, only when currency matches.
  //    Fires only when the contract itself states a total value. ──────────────
  const vInv = numOf(invoice, 'total_value');
  const vC = numOf(contract, 'total_value');
  if (invoice && contract && vInv !== null && vC !== null) {
    const cInv = strOf(invoice, 'currency');
    const cC = strOf(contract, 'currency');
    // Only compare amounts when BOTH currencies are known and equal — comparing
    // 1000 USD vs 1000 EUR as "equal" (or flagging them) would be wrong.
    const sameCurrency = !!cInv && !!cC && cInv.toUpperCase() === cC.toUpperCase();
    const base = Math.abs(vC);
    const rel = base > 0 ? Math.abs(vInv - vC) / base : vInv === vC ? 0 : 1;
    if (sameCurrency && rel > VALUE_TOLERANCE) {
      out.push({
        field: 'total_value',
        expected: `contract: ${vC} ${show(cC)}`,
        actual: `invoice: ${vInv} ${show(cInv)}`,
        severity: 'error',
        kind: kindFor(invoice, contract, 'total_value'),
        citations: [cite(contract, `${vC} ${show(cC)}`), cite(invoice, `${vInv} ${show(cInv)}`)],
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

  // ── Incoterms should agree between the invoice and the contract. ───────────
  const incInv = strOf(invoice, 'incoterm');
  const incC = strOf(contract, 'incoterm');
  if (invoice && contract && incInv && incC && !sameIncoterm(incInv, incC)) {
    out.push({
      field: 'incoterm',
      expected: `contract: ${incC}`,
      actual: `invoice: ${incInv}`,
      severity: 'warning',
      kind: kindFor(invoice, contract, 'incoterm'),
      citations: [cite(invoice, incInv), cite(contract, incC)],
    });
  }

  // ── Parties cross-check: seller/buyer names between invoice and contract.
  //    Names are fuzzy, so these are always YELLOW (suspected), never asserted. ─
  crossCheckParty(invoice, contract, 'seller', out);
  crossCheckParty(invoice, contract, 'buyer', out);

  // ── Manufacturer & registration number must be consistent across EVERY
  //    document that states them (labels, COA, invoice…). Catches e.g. labels
  //    naming "Sujata Nutri-Pharma" while a COA names "Sujata Chemicals". ──────
  checkManufacturerConsistency(docs, out);
  checkRegistrationConsistency(docs, out);

  // ── Line items: reconcile per-row for small shipments; honest degradation for
  //    many-item invoices (plan Q12/Q26). ─────────────────────────────────────
  reconcileLineItems(invoice, packing, out);

  // ── Trilateral (3-party): two invoice legs, markup direction, physical
  //    consistency across legs, intermediary orientation, inbound Incoterm. ────
  if (trilateral) {
    reconcileTrilateral(invoiceRefs, outbound, inbound, opts, out);
  }

  // ── Transparency: never pretend we checked what we couldn't. Surface both
  //    duplicate documents (only the first is reconciled) and missing
  //    counterparts (whole cross-checks skipped) as explicit YELLOW notes. ────
  for (const t of ['invoice', 'contract', 'packing_list'] as const) {
    const n = docs.filter((d) => d.doc_type === t).length;
    // Trilateral legitimately has TWO invoices (inbound + outbound) — warn only
    // on 3+; bilateral warns on 2+ as before.
    const threshold = t === 'invoice' && trilateral ? 2 : 1;
    if (n > threshold) {
      const used = t === 'invoice' ? invoice : t === 'contract' ? contract : packing;
      const others = docs
        .filter((d) => d.doc_type === t && d.file_id !== used?.file_id)
        .map((d) => d.file_name ?? '—');
      out.push({
        field: 'documents',
        expected: 'один документ цього типу',
        actual:
          `${t}: знайдено ${n} — звірено «${used?.file_name ?? '—'}»` +
          (others.length ? `; інші не звірено: ${others.join(', ')}` : ''),
        severity: 'warning',
        kind: 'suspected',
        citations: [],
      });
    }
  }
  if (invoice && !contract) {
    out.push({
      field: 'documents',
      expected: 'контракт для звірки ціни/валюти/Incoterms',
      actual: 'Контракт відсутній — ціну/валюту/Incoterms не звірено',
      severity: 'info',
      kind: 'suspected',
      citations: [],
    });
  }
  if (invoice && !packing) {
    out.push({
      field: 'documents',
      expected: 'пакувальний лист для звірки ваги/кількості',
      actual: 'Пакувальний лист відсутній — вагу/кількість/позиції не звірено',
      severity: 'info',
      kind: 'suspected',
      citations: [],
    });
  }

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

const INCOTERM_RX = /\b(EXW|FCA|FAS|FOB|CFR|CNF|CIF|CPT|CIP|DAP|DPU|DAT|DDP|DDU)\b/i;

/** The 3-letter Incoterms rule in a free-text term ("CPT - Bila Tserkva (INCOTERMS 2010)" → "CPT"). */
export function incotermCode(term: string | null | undefined): string | null {
  const m = term ? INCOTERM_RX.exec(term) : null;
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * Two Incoterms agree when their rule (CPT/FCA/…) agrees. The named place is
 * spelled differently across documents ("Bila Tserkva" / "Bila Tzerkva") and is
 * not a customs-relevant mismatch on its own; fall back to the raw string only
 * when no rule code can be read.
 */
function sameIncoterm(a: string, b: string): boolean {
  const ca = incotermCode(a);
  const cb = incotermCode(b);
  if (ca && cb) return ca === cb;
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

function normalizeHs(hs: string): string {
  // Digits only, and drop leading zeros so a dropped-leading-zero read
  // ("0102030000" vs "102030000") is not a false mismatch. Genuinely different
  // codes stay different (differing length/digits).
  return hs.replace(/\D/g, '').replace(/^0+/, '');
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|llc|inc|gmbh|co|corp|company|pvt|private|тов|ооо|пп|лтд)\b/g, '')
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

function toRef(d: ReconcileDoc): DocRef {
  return { file_id: d.file_id, file_name: d.file_name, doc_type: d.doc_type ?? 'other', fields: d.fields };
}

// Internal companies (mirror services/parties.ts INTERNAL_COMPANIES). Used to
// orient the two invoice legs of a trilateral deal from the seller/buyer names.
const IMPORTER_RX = /agroup|а\s*груп|а\s*group|group\s*95|груп\s*95/i; // AGroup95 (final importer)
const INTERMEDIARY_RX = /prime\s*force|primeforce|прайм\s*?форс/i; // PrimeForce (intermediary)

function nameMatches(name: string | null, rx: RegExp): boolean {
  return !!name && rx.test(name);
}

/**
 * Which leg an invoice belongs to in a trilateral deal, from its seller/buyer:
 *   outbound (Prime→AGroup95) — buyer is the importer, or seller is the intermediary
 *   inbound  (Supplier→Prime) — buyer is the intermediary
 * `unknown` when the names don't identify a leg (never guessed).
 */
function classifyInvoiceLeg(ref: DocRef, intermediary: string | null): 'outbound' | 'inbound' | 'unknown' {
  const seller = strOf(ref, 'seller');
  const buyer = strOf(ref, 'buyer');
  // The shipment's own intermediary (parties card) first; the known group
  // companies are only a fallback for shipments whose parties aren't filled yet.
  if (intermediary) {
    if (sameName(seller, intermediary)) return 'outbound';
    if (sameName(buyer, intermediary)) return 'inbound';
  }
  if (nameMatches(buyer, IMPORTER_RX) || nameMatches(seller, INTERMEDIARY_RX)) return 'outbound';
  if (nameMatches(buyer, INTERMEDIARY_RX)) return 'inbound';
  return 'unknown';
}

function sameName(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ka = normalizeName(a);
  const kb = normalizeName(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  return Math.min(ka.length, kb.length) >= 5 && (ka.includes(kb) || kb.includes(ka));
}

/**
 * Trilateral-only checks. All honest: the value gap between legs is surfaced as
 * expected markup (INFO), not a mismatch; a missing second leg or an unconfirmed
 * intermediary is a YELLOW "please verify", never a silent skip.
 */
function reconcileTrilateral(
  invoices: DocRef[],
  outbound: DocRef | null,
  inbound: DocRef | null,
  opts: ReconcileOptions,
  out: Discrepancy[],
): void {
  // Leg presence: a 3-party deal normally has TWO invoice sets.
  if (invoices.length < 2) {
    out.push({
      field: 'documents',
      expected: 'два набори інвойсів (постачальник→посередник і посередник→імпортер)',
      actual:
        invoices.length === 1
          ? 'знайдено лише один інвойс — для тристороннього постачання очікується два плеча'
          : 'інвойси відсутні',
      severity: 'info',
      kind: 'suspected',
      citations: invoices.map((i) => cite(i, i.doc_type)),
    });
  }

  // Markup direction: inbound (Supplier→Prime) should not exceed outbound
  // (Prime→AGroup95). This REPLACES treating the two invoice values as a
  // mismatch — the difference is expected markup, surfaced as INFO.
  if (outbound && inbound) {
    const vIn = numOf(inbound, 'total_value');
    const vOut = numOf(outbound, 'total_value');
    const cIn = strOf(inbound, 'currency');
    const cOut = strOf(outbound, 'currency');
    const sameCurrency = !!cIn && !!cOut && cIn.toUpperCase() === cOut.toUpperCase();
    if (vIn !== null && vOut !== null && sameCurrency) {
      if (vIn > vOut) {
        // RED: the declared (outbound) value is below what the goods were bought
        // for on the inbound leg — the classic trigger for a customs-value
        // adjustment (МКУ ст. 55). Not a document typo, a valuation risk that
        // needs a written justification before clearance.
        const pct = Math.round(((vIn - vOut) / vIn) * 100);
        out.push({
          field: 'markup',
          expected: 'ціна перепродажу ≥ ціни закупівлі на вхідному плечі',
          actual:
            `вхідний інвойс ${vIn} ${cIn} > вихідний ${vOut} ${cOut} (продаж на ${pct}% нижче закупівлі) — ` +
            'ризик коригування митної вартості; потрібне письмове обґрунтування ціни',
          severity: 'error',
          kind: kindFor(inbound, outbound, 'total_value'),
          citations: [cite(inbound, `${vIn} ${show(cIn)}`), cite(outbound, `${vOut} ${show(cOut)}`)],
        });
      } else {
        const pct = vOut > 0 ? Math.round(((vOut - vIn) / vOut) * 100) : 0;
        out.push({
          field: 'markup',
          expected: 'очікувана націнка посередника',
          actual: `вхідний ${vIn} → вихідний ${vOut} ${cOut} (націнка ~${pct}%) — норма для тристороннього`,
          severity: 'info',
          kind: 'suspected',
          citations: [cite(inbound, `${vIn} ${show(cIn)}`), cite(outbound, `${vOut} ${show(cOut)}`)],
        });
      }
    }

    // Physical goods (weights / places) across the two legs are covered by the
    // document-wide checkPhysicalConsistency() — one grouped finding, not two.
  }

  // Intermediary orientation: PrimeForce should be the outbound SELLER and/or the
  // inbound BUYER. Emit ONE honest note only when it can't be confirmed anywhere.
  const isIntermediary = (name: string | null): boolean =>
    (!!opts.intermediaryName && sameName(name, opts.intermediaryName)) || nameMatches(name, INTERMEDIARY_RX);
  const intermediaryConfirmed =
    (!!outbound && isIntermediary(strOf(outbound, 'seller'))) ||
    (!!inbound && isIntermediary(strOf(inbound, 'buyer')));
  if (invoices.length >= 1 && !intermediaryConfirmed) {
    out.push({
      field: 'intermediary',
      expected: 'посередник як продавець вихідного / покупець вхідного інвойсу',
      actual: 'посередника не підтверджено в інвойсах — перевірте сторони',
      severity: 'warning',
      kind: 'suspected',
      citations: [],
    });
  }

  // Inbound leg Incoterm vs the buy-side workspace Incoterm (the outbound leg is
  // already covered by the invoice↔contract Incoterm check).
  if (inbound && opts.incotermIn) {
    const inc = strOf(inbound, 'incoterm');
    if (inc && !sameIncoterm(inc, opts.incotermIn)) {
      out.push({
        field: 'incoterm',
        expected: `вхідне плече: ${opts.incotermIn}`,
        actual: `вхідний інвойс: ${inc}`,
        severity: 'warning',
        kind: 'suspected',
        citations: [cite(inbound, inc)],
      });
    }
  }
}

/**
 * Documents that describe THIS cargo's product (and so must agree on
 * manufacturer / registration). `other` is excluded: it is where unrelated
 * files land (e.g. registration certificates of a different finished product).
 */
function isProductDoc(d: ReconcileDoc): boolean {
  return !!d.doc_type && d.doc_type !== 'other';
}

/**
 * A regulatory (drug / veterinary) registration number — UA/19603/01/01 or
 * АВ-09881-03-25 — NOT an AWB/CMR/MRN/declaration/certificate number, which the
 * extractor sometimes files under `registration_number`.
 */
const REGISTRATION_RX = /^(UA\/\d{3,6}\/\d{2}\/\d{2}(\/\d{2})?|[AА][BВ]-\d{4,6}-\d{2}-\d{2})$/i;
export function isRegulatoryRegistration(val: string): boolean {
  return REGISTRATION_RX.test(val.trim().replace(/\s+/g, ''));
}

/** "«A» (file1, file2) · «B» (file3)" — the distinct values and where each was read. */
function distinctValues(entries: { ref: DocRef; val: string }[]): string {
  const groups = new Map<string, { val: string; files: string[] }>();
  for (const e of entries) {
    const k = normalizeName(e.val) || e.val;
    const g = groups.get(k) ?? { val: e.val, files: [] };
    g.files.push(e.ref.file_name ?? e.ref.doc_type);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => `«${g.val}» (${g.files.join(', ')})`).join(' · ');
}

/**
 * Net / gross weight and packages count describe the SAME physical cargo in
 * every document (invoices of both legs, packing lists, AWB/CMR/T1, МД, COO), so
 * any difference is surfaced, grouped by value with the files that state it.
 * A weight gap above the 1% tolerance (or any places difference) is RED; a small
 * weight gap (rounded 31.85 → 32 kg) is YELLOW — still worth aligning, because
 * the declared weight must match the shipping documents.
 */
const PHYSICAL_DOC_TYPES = new Set([
  'invoice',
  'packing_list',
  'transport',
  'customs_declaration',
  'certificate_of_origin',
]);
const PHYSICAL_LABEL: Record<string, string> = {
  net_weight_kg: 'вага нетто, кг',
  gross_weight_kg: 'вага брутто, кг',
  packages_count: 'кількість місць',
};
function checkPhysicalConsistency(
  docs: ReconcileDoc[],
  field: 'net_weight_kg' | 'gross_weight_kg' | 'packages_count',
  out: Discrepancy[],
): void {
  // Editable drafts (.doc/.xlsx) are skipped when an issued document of the same
  // type exists — a superseded draft's weights are not a mismatch.
  const issuedTypes = new Set(docs.filter((d) => !isLikelyDraft(d.file_name)).map((d) => d.doc_type));
  const groups = new Map<number, DocRef[]>();
  for (const d of docs) {
    if (!d.doc_type || !PHYSICAL_DOC_TYPES.has(d.doc_type)) continue;
    if (isLikelyDraft(d.file_name) && issuedTypes.has(d.doc_type)) continue;
    const ref = toRef(d);
    const v = numOf(ref, field);
    if (v === null || v <= 0) continue;
    const key = Math.round(v * 1000) / 1000;
    groups.set(key, [...(groups.get(key) ?? []), ref]);
  }
  if (groups.size < 2) return;
  const values = [...groups.keys()].sort((a, b) => a - b);
  const min = values[0]!;
  const max = values[values.length - 1]!;
  // Places: carriers often count PALLETS where the packing list counts cartons,
  // so a gap that only involves transport documents / COO is a check-this
  // (YELLOW); a gap among the commercial documents and the МД is RED.
  const commercial = new Set(['invoice', 'packing_list', 'customs_declaration']);
  const commercialValues = new Set(
    [...groups.entries()].filter(([, refs]) => refs.some((r) => commercial.has(r.doc_type))).map(([v]) => v),
  );
  const big =
    field === 'packages_count' ? commercialValues.size > 1 : (max - min) / min > WEIGHT_TOLERANCE;
  // Majority value first — what most documents say is the reference point.
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  const list = (refs: DocRef[]): string => refs.map((r) => r.file_name ?? r.doc_type).join(', ');
  const [major, ...rest] = ordered;
  const lowConf = [...groups.values()].flat().some((r) => confidenceOf(r, field) === 'low');
  out.push({
    field,
    expected: `${PHYSICAL_LABEL[field]}: ${major![0]} (${list(major![1])})`,
    actual: rest.map(([v, refs]) => `${v} (${list(refs)})`).join(' · '),
    severity: big ? 'error' : 'warning',
    kind: big && !lowConf ? 'confirmed' : 'suspected',
    citations: ordered.flatMap(([v, refs]) => refs.map((r) => cite(r, v))),
  });
}

/** Every document that states `field`, paired with its value. */
function docsWithField(docs: ReconcileDoc[], field: string): { ref: DocRef; val: string }[] {
  const out: { ref: DocRef; val: string }[] = [];
  for (const d of docs) {
    const ref = toRef(d);
    const val = strOf(ref, field);
    if (val) out.push({ ref, val });
  }
  return out;
}

/** Manufacturer name must agree across all documents (fuzzy → YELLOW). */
function checkManufacturerConsistency(docs: ReconcileDoc[], out: Discrepancy[]): void {
  const entries = docsWithField(docs.filter(isProductDoc), 'manufacturer');
  if (entries.length < 2) return;
  let mismatch = false;
  for (const a of entries) {
    for (const b of entries) {
      if (a === b) continue;
      const ka = normalizeName(a.val);
      const kb = normalizeName(b.val);
      if (ka && kb && !ka.includes(kb) && !kb.includes(ka)) mismatch = true;
    }
  }
  if (!mismatch) return;
  out.push({
    field: 'manufacturer',
    expected: 'єдиний виробник у всіх документах',
    actual: `назви виробника різняться: ${distinctValues(entries)}`,
    severity: 'warning',
    kind: 'suspected',
    citations: entries.map((e) => cite(e.ref, e.val)),
  });
}

/** Registration number must be identical everywhere it appears (normalized). */
function checkRegistrationConsistency(docs: ReconcileDoc[], out: Discrepancy[]): void {
  const entries = docsWithField(docs.filter(isProductDoc), 'registration_number').filter((e) =>
    isRegulatoryRegistration(e.val),
  );
  if (entries.length < 2) return;
  const norm = (s: string): string => s.toUpperCase().replace(/\s+/g, '');
  const distinct = new Set(entries.map((e) => norm(e.val)));
  if (distinct.size <= 1) return;
  out.push({
    field: 'registration_number',
    expected: entries[0]!.val,
    actual: entries.map((e) => `${e.ref.doc_type}: ${e.val}`).join(' | '),
    severity: 'warning',
    kind: 'suspected',
    citations: entries.map((e) => cite(e.ref, e.val)),
  });
}

function reconcileLineItems(
  invoice: DocRef | null,
  packing: DocRef | null,
  out: Discrepancy[],
): void {
  // A packing list typically splits one invoice line across cartons (10 + 10 + 5
  // kg of the SAME batch); compare per product/batch, not per physical row.
  const invItems = aggregateLines(Array.isArray(invoice?.fields.line_items) ? invoice!.fields.line_items : []);
  const plItems = aggregateLines(Array.isArray(packing?.fields.line_items) ? packing!.fields.line_items : []);
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

  // Small shipment: reconcile the item count between the two docs…
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

  // …AND compare matched rows field-by-field (quantity / amount / HS code) —
  // the row COUNT agreeing does not mean the rows agree. Match by batch number
  // when available, else by normalized description. Unmatched rows are left to
  // the count check above.
  const usedPl = new Set<number>();
  for (const inv of invItems) {
    const key = lineKey(inv);
    if (!key) continue;
    const j = plItems.findIndex((p, idx) => !usedPl.has(idx) && lineKey(p) === key);
    if (j === -1) continue;
    usedPl.add(j);
    const pl = plItems[j]!;
    const label = inv.description ?? inv.batch_no ?? key;

    // Quantities are comparable only in the same unit (invoice in kg vs packing
    // list in drums is not a mismatch) — different units → a yellow check-this.
    const invUnit = normalizeUnit(inv.unit);
    const plUnit = normalizeUnit(pl.unit);
    const unitsDiffer = invUnit !== null && plUnit !== null && invUnit !== plUnit;
    if (unitsDiffer && inv.quantity !== null && pl.quantity !== null) {
      out.push({
        field: 'line_quantity',
        expected: `invoice «${label}»: ${inv.quantity} ${inv.unit}`,
        actual: `packing_list: ${pl.quantity} ${pl.unit} (інші одиниці — перевірте перерахунок)`,
        severity: 'warning',
        kind: 'suspected',
        citations: [cite(invoice, inv.quantity), cite(packing, pl.quantity)],
      });
    } else if (inv.quantity !== null && pl.quantity !== null && inv.quantity > 0) {
      const rel = Math.abs(inv.quantity - pl.quantity) / inv.quantity;
      if (rel > WEIGHT_TOLERANCE) {
        out.push({
          field: 'line_quantity',
          expected: `invoice «${label}»: ${inv.quantity}`,
          actual: `packing_list: ${pl.quantity}`,
          severity: 'error',
          kind: 'confirmed',
          citations: [cite(invoice, inv.quantity), cite(packing, pl.quantity)],
        });
      }
    }

    if (inv.amount !== null && pl.amount !== null && inv.amount > 0) {
      const rel = Math.abs(inv.amount - pl.amount) / inv.amount;
      if (rel > VALUE_TOLERANCE) {
        out.push({
          field: 'line_amount',
          expected: `invoice «${label}»: ${inv.amount}`,
          actual: `packing_list: ${pl.amount}`,
          severity: 'error',
          kind: 'confirmed',
          citations: [cite(invoice, inv.amount), cite(packing, pl.amount)],
        });
      }
    }

    if (inv.hs_code && pl.hs_code && normalizeHs(inv.hs_code) !== normalizeHs(pl.hs_code)) {
      out.push({
        field: 'line_hs_code',
        expected: `invoice «${label}»: ${inv.hs_code}`,
        actual: `packing_list: ${pl.hs_code}`,
        severity: 'warning',
        kind: 'confirmed',
        citations: [cite(invoice, inv.hs_code), cite(packing, pl.hs_code)],
      });
    }
  }
}

/**
 * Collapse rows that describe the same product/batch into one, summing quantity
 * and amount (quantity only when the units agree). Rows without a key are kept.
 */
export function aggregateLines(items: ExtractedLineItem[]): ExtractedLineItem[] {
  const out: ExtractedLineItem[] = [];
  const byKey = new Map<string, ExtractedLineItem>();
  for (const it of items) {
    const key = lineKey(it);
    const prev = key ? byKey.get(key) : undefined;
    if (!key || !prev) {
      const copy = { ...it };
      out.push(copy);
      if (key) byKey.set(key, copy);
      continue;
    }
    const sameUnit = normalizeUnit(prev.unit) === normalizeUnit(it.unit);
    prev.quantity =
      sameUnit && prev.quantity !== null && it.quantity !== null ? prev.quantity + it.quantity : null;
    prev.amount = prev.amount !== null && it.amount !== null ? prev.amount + it.amount : null;
    prev.hs_code = prev.hs_code ?? it.hs_code;
  }
  return out;
}

/** Row-matching key: prefer batch number, else normalized description. */
function lineKey(it: ExtractedLineItem): string {
  const b = it.batch_no ? it.batch_no.toLowerCase().replace(/[^a-z0-9а-яіїєґ]/gi, '') : '';
  if (b) return b;
  return it.description ? it.description.toLowerCase().replace(/[^a-z0-9а-яіїєґ]/gi, '') : '';
}

const UNIT_ALIASES: Record<string, string> = {
  kg: 'kg', kgs: 'kg', кг: 'kg', kilogram: 'kg', kilograms: 'kg', кілограм: 'kg',
  g: 'g', gr: 'g', г: 'g', gram: 'g', grams: 'g',
  t: 't', mt: 't', ton: 't', tons: 't', tonne: 't', т: 't',
  l: 'l', ltr: 'l', л: 'l', litre: 'l', liter: 'l',
  pcs: 'pcs', pc: 'pcs', шт: 'pcs', piece: 'pcs', pieces: 'pcs', units: 'pcs', unit: 'pcs',
};

/** Canonical unit for comparison; null when unknown/absent (then quantities are compared as-is). */
export function normalizeUnit(u: string | null | undefined): string | null {
  if (!u) return null;
  const k = u.trim().toLowerCase().replace(/[.\s]/g, '');
  if (!k) return null;
  return UNIT_ALIASES[k] ?? k;
}

