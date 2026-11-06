import { sameCompany } from '../shipments/contextDerive.js';
import type { ExtractedBankAccount, ExtractedDangerousGoods } from '../ingest/extraction/extractFields.js';
import { isLikelyDraft, type Discrepancy, type DiscrepancyCitation, type ReconcileDoc } from './reconcile.js';
import { label, type Risk } from './risks.js';

/**
 * Deterministic document-integrity checks: what the agent used to notice only
 * when it happened to read a document in full now fires on every verdict run.
 * Pure — a function of the stored extractions (bank_accounts, dangerous_goods,
 * signed / stamped, empty_fields). Extractions made before these fields existed
 * simply lack them and yield nothing (never a guess).
 *
 *   - bank details of the SAME seller that disagree between its payment
 *     documents → discrepancy `bank_account`;
 *   - a bank block whose beneficiary is the buyer → risk `bank_beneficiary_buyer`;
 *   - a dangerous good declared somewhere → risk `dangerous_goods` (info), and
 *     `dangerous_goods_undeclared` when the transport papers / МД omit it;
 *   - a certificate without signature / stamp or with blank fields →
 *     `certificate_incomplete`;
 *   - an invoice / packing list / contract with blank key fields → `empty_fields`.
 */

export interface FlagDoc extends ReconcileDoc {
  /** The text reads as a veterinary / health certificate (verdicts snapshot). */
  vet_certificate?: boolean;
}

type Fields = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

// ── tolerant readers over stored JSON (old extractions lack the fields) ──────

export function bankAccountsOf(f: Fields | null | undefined): ExtractedBankAccount[] {
  const raw = f?.bank_accounts;
  if (!Array.isArray(raw)) return [];
  const out: ExtractedBankAccount[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const acc = { iban: str(r.iban), swift: str(r.swift), bank_name: str(r.bank_name), beneficiary: str(r.beneficiary) };
    if (acc.iban || acc.swift || acc.bank_name || acc.beneficiary) out.push(acc);
  }
  return out;
}

export function dangerousGoodsOf(f: Fields | null | undefined): ExtractedDangerousGoods | null {
  const raw = f?.dangerous_goods;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    is_dangerous: typeof r.is_dangerous === 'boolean' ? r.is_dangerous : null,
    un_number: str(r.un_number),
    adr_class: str(r.adr_class),
    packing_group: str(r.packing_group),
  };
}

export function emptyFieldsOf(f: Fields | null | undefined): string[] {
  const raw = f?.empty_fields;
  return Array.isArray(raw) ? raw.map(str).filter((s): s is string => !!s) : [];
}

/** IBAN / account number without spaces, uppercased. */
export function normIban(v: string | null): string | null {
  const s = v?.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s ? s : null;
}

/** "UN1940" / "UN 1940" / "1940" → "UN 1940"; null when there are no four digits. */
export function normUn(v: string | null): string | null {
  const m = v ? /(\d{4})/.exec(v) : null;
  return m ? `UN ${m[1]}` : null;
}

/** A declared dangerous good: is_dangerous true or a UN number stated. */
export function declaresDanger(dg: ExtractedDangerousGoods | null): boolean {
  return !!dg && (dg.is_dangerous === true || !!normUn(dg.un_number));
}

function hasType(d: ReconcileDoc, type: string): boolean {
  if (d.doc_type === type) return true;
  const also = d.fields.also_contains;
  return Array.isArray(also) && (also as unknown[]).includes(type);
}

const DRAFT_NAME_RX = /draft|чернет|черновик|проект/i;
function isDraft(d: ReconcileDoc): boolean {
  return isLikelyDraft(d.file_name) || DRAFT_NAME_RX.test(d.file_name ?? '');
}

function name(d: ReconcileDoc): string {
  return d.file_name ?? d.doc_type ?? 'документ';
}

function cite(d: ReconcileDoc, value: string): DiscrepancyCitation {
  return { file_id: d.file_id, file_name: d.file_name, doc_type: d.doc_type ?? 'other', value };
}

// ── a. bank details ─────────────────────────────────────────────────────────

/**
 * A document someone pays on: an invoice (any kind — proforma / advance / final
 * all land in `invoice`), or an `other` file that states a total and bank
 * details and is not a bill for services (those are the forwarder's / broker's).
 */
export function isPaymentDoc(d: ReconcileDoc): boolean {
  if (hasType(d, 'invoice')) return true;
  return (
    d.doc_type === 'other' &&
    !str(d.fields.service_kind) &&
    typeof d.fields.total_value === 'number' &&
    bankAccountsOf(d.fields).length > 0
  );
}

/** The bank block names the document's buyer (and not its seller) as beneficiary. */
function isBuyerBlock(acc: ExtractedBankAccount, d: ReconcileDoc): boolean {
  const buyer = str(d.fields.buyer);
  const seller = str(d.fields.seller);
  return !!acc.beneficiary && sameCompany(acc.beneficiary, buyer) && !sameCompany(acc.beneficiary, seller);
}

/** Same bank: SWIFT (institution + country + location), else bank name, else the IBAN's bank code. */
function sameBank(a: ExtractedBankAccount, b: ExtractedBankAccount): boolean | null {
  const sa = a.swift?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const sb = b.swift?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (sa && sb) return sa === sb;
  if (a.bank_name && b.bank_name) return sameCompany(a.bank_name, b.bank_name);
  const ia = normIban(a.iban);
  const ib = normIban(b.iban);
  // IBAN: country (2) + check digits (2) + bank code (first 4 chars of the BBAN).
  if (ia && ib && /^[A-Z]{2}\d{2}/.test(ia) && /^[A-Z]{2}\d{2}/.test(ib)) {
    return ia.slice(0, 2) + ia.slice(4, 8) === ib.slice(0, 2) + ib.slice(4, 8);
  }
  return null;
}

function showAccount(acc: ExtractedBankAccount): string {
  const iban = normIban(acc.iban);
  const bits = [iban ? `IBAN ${iban}` : null, acc.bank_name, acc.swift ? `SWIFT ${acc.swift}` : null]
    .filter(Boolean)
    .join(', ');
  return acc.beneficiary ? `${bits}${bits ? ', ' : ''}отримувач «${acc.beneficiary}»` : bits;
}

/**
 * Bank details of one seller must agree across its payment documents. Sellers
 * are grouped by name (never compared across sellers — a trilateral deal has
 * two invoice legs with different sellers and, legitimately, different banks).
 */
export function checkBankAccounts(docs: ReconcileDoc[]): Discrepancy[] {
  interface Entry { d: ReconcileDoc; seller: string; accounts: ExtractedBankAccount[] }
  const groups: Entry[][] = [];
  for (const d of docs.filter(isPaymentDoc)) {
    const seller = str(d.fields.seller);
    const accounts = bankAccountsOf(d.fields).filter((a) => !isBuyerBlock(a, d));
    if (!seller || accounts.length === 0) continue;
    const g = groups.find((x) => sameCompany(x[0]!.seller, seller));
    if (g) g.push({ d, seller, accounts });
    else groups.push([{ d, seller, accounts }]);
  }

  const out: Discrepancy[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const A = g[i]!;
        const B = g[j]!;
        const ibansA = new Set(A.accounts.map((a) => normIban(a.iban)).filter(Boolean));
        const ibansB = new Set(B.accounts.map((b) => normIban(b.iban)).filter(Boolean));
        const shareIban = [...ibansA].some((x) => ibansB.has(x));
        const curA = str(A.d.fields.currency)?.toUpperCase() ?? null;
        const curB = str(B.d.fields.currency)?.toUpperCase() ?? null;
        const currenciesDiffer = !!curA && !!curB && curA !== curB;

        for (const b of B.accounts) {
          const ib = normIban(b.iban);
          for (const a of A.accounts) {
            const ia = normIban(a.iban);
            const benDiff = !!a.beneficiary && !!b.beneficiary && !sameCompany(a.beneficiary, b.beneficiary);
            let what: 'iban' | 'bank' | 'beneficiary' | null = null;
            if (benDiff) what = 'beneficiary';
            else if (ia && ib && ia !== ib && !ibansA.has(ib)) {
              const bank = sameBank(a, b);
              if (bank === true) what = 'iban';
              else if (bank === false && !shareIban) what = 'bank';
            }
            if (!what) continue;
            const key = [what, ...[ia ?? a.beneficiary ?? '', ib ?? b.beneficiary ?? ''].sort()].join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            const bothRead = !!ia && !!ib;
            // Accounts in different currencies at one bank are normal (USD / EUR).
            const firm = what === 'beneficiary' || (what === 'iban' && !currenciesDiffer);
            const why =
              what === 'iban'
                ? 'той самий банк, різні рахунки'
                : what === 'bank'
                  ? 'різні банки, спільного рахунку немає'
                  : 'різні отримувачі платежу';
            out.push({
              field: 'bank_account',
              expected: `однакові банківські реквізити продавця «${A.seller}» у всіх рахунках`,
              actual: `«${name(A.d)}»: ${showAccount(a)} · «${name(B.d)}»: ${showAccount(b)} — ${why}`,
              severity: firm ? 'error' : 'warning',
              kind: firm && bothRead ? 'confirmed' : 'suspected',
              citations: [cite(A.d, showAccount(a)), cite(B.d, showAccount(b))],
            });
            break; // one finding per account of B
          }
        }
      }
    }
  }
  return out;
}

// ── risks ───────────────────────────────────────────────────────────────────

const SDS_NAME_RX = /(^|[^a-z])m?sds([^a-z]|$)|safety[\s_-]*data/i;
const NUMBER_FIELD_RX = /\b(no|nr|num|number)\b|№|#|номер/i;
const CONSIGNEE_FIELD_RX = /consignee|вантажоодерж|грузополуч|получател/i;
const BATCH_FIELD_RX = /batch|\blot\b|парті|парти|сері/i;
const DATE_FIELD_RX = /date|дата/i;

/** Ends the text with one full stop ("Batch No." must not become "Batch No.."). */
function sentence(s: string): string {
  return s.endsWith('.') ? s : `${s}.`;
}

function joinNames(list: ReconcileDoc[]): string {
  return list.map((d) => `«${name(d)}»`).join(', ');
}

/** Payment risk: a bank block made out to the buyer. */
function buyerBankRisks(docs: ReconcileDoc[]): Risk[] {
  const out: Risk[] = [];
  for (const d of docs.filter(isPaymentDoc)) {
    const block = bankAccountsOf(d.fields).find((a) => isBuyerBlock(a, d));
    if (!block) continue;
    out.push({
      code: 'bank_beneficiary_buyer',
      category: 'payment',
      severity: 'warning',
      title: 'Банківські реквізити на ім’я покупця',
      detail:
        `«${name(d)}» — отримувач платежу «${block.beneficiary}» збігається з покупцем ` +
        `(${showAccount(block)}). Перевірте, на чий рахунок має йти оплата.`,
      source_file_id: d.file_id,
    });
  }
  return out;
}

/** Dangerous goods: always named (info); a warning when the carriers' papers omit it. */
function dangerousGoodsRisks(docs: ReconcileDoc[]): Risk[] {
  const declaring = docs.filter((d) => declaresDanger(dangerousGoodsOf(d.fields)));
  if (declaring.length === 0) return [];
  // One entry per UN number ('' = declared dangerous, no UN number stated).
  const byUn = new Map<string, { classes: Set<string>; groups: Set<string>; docs: ReconcileDoc[] }>();
  for (const d of declaring) {
    const dg = dangerousGoodsOf(d.fields)!;
    const un = normUn(dg.un_number) ?? '';
    const e = byUn.get(un) ?? { classes: new Set<string>(), groups: new Set<string>(), docs: [] };
    if (dg.adr_class) e.classes.add(dg.adr_class);
    if (dg.packing_group) e.groups.add(dg.packing_group);
    e.docs.push(d);
    byUn.set(un, e);
  }
  const describe = (un: string, e: { classes: Set<string>; groups: Set<string> }): string =>
    [
      un || 'небезпечний вантаж без UN-номера',
      e.classes.size ? `клас ${[...e.classes].join('/')}` : null,
      e.groups.size ? `пакувальна група ${[...e.groups].join('/')}` : null,
    ]
      .filter(Boolean)
      .join(', ');

  const out: Risk[] = [
    {
      code: 'dangerous_goods',
      category: 'dangerous_goods',
      severity: 'info',
      title: 'Небезпечний вантаж',
      detail:
        'Документи заявляють небезпечний вантаж: ' +
        [...byUn.entries()].map(([un, e]) => `${describe(un, e)} (${joinNames(e.docs)})`).join('; ') +
        '. Перевезення і митне оформлення мають це відображати.',
      source_file_id: declaring[0]!.file_id,
    },
  ];

  const carriers = docs.filter((d) => hasType(d, 'transport') || hasType(d, 'customs_declaration'));
  for (const [un, e] of byUn) {
    const missing = carriers.filter((c) => {
      if (e.docs.includes(c)) return false;
      const dg = dangerousGoodsOf(c.fields);
      return un ? normUn(dg?.un_number ?? null) !== un : !declaresDanger(dg);
    });
    if (missing.length === 0) continue;
    out.push({
      code: 'dangerous_goods_undeclared',
      category: 'dangerous_goods',
      severity: 'warning',
      title: `Небезпечний вантаж ${un || ''} не зазначено в транспортних / митних документах`.replace(/\s+/g, ' '),
      detail: `${describe(un, e)} заявлено в ${joinNames(e.docs)}, але не зазначено в ${joinNames(missing)}.`,
      source_file_id: missing[0]!.file_id,
    });
  }
  return out;
}

function isCertificate(d: FlagDoc): boolean {
  if (d.doc_type === 'quality_certificate' || d.doc_type === 'certificate_of_origin') return true;
  return !!d.vet_certificate && (!d.doc_type || d.doc_type === 'other');
}

/** Certificates without signature / stamp or with blank fields. */
function certificateRisks(docs: FlagDoc[]): Risk[] {
  const out: Risk[] = [];
  for (const d of docs) {
    if (!isCertificate(d) || isDraft(d) || SDS_NAME_RX.test(d.file_name ?? '')) continue;
    const gaps: string[] = [];
    if (d.fields.signed === false) gaps.push('без підпису');
    if (d.fields.stamped === false) gaps.push('без печатки');
    const empty = emptyFieldsOf(d.fields);
    if (empty.length) gaps.push(`порожні поля: ${empty.join(', ')}`);
    if (gaps.length === 0) continue;
    const kind = d.vet_certificate && d.doc_type !== 'quality_certificate' && d.doc_type !== 'certificate_of_origin'
      ? 'Ветеринарний сертифікат'
      : label(d.doc_type ?? 'документ');
    out.push({
      code: 'certificate_incomplete',
      category: 'document_quality',
      severity: 'warning',
      title: `${kind} оформлено не повністю`,
      detail: sentence(`«${name(d)}» — ${gaps.join('; ')}`),
      source_file_id: d.file_id,
    });
  }
  return out;
}

/** Invoice / packing list / contract with blank key fields (number, consignee, batch, date). */
function emptyFieldRisks(docs: ReconcileDoc[]): Risk[] {
  const out: Risk[] = [];
  for (const d of docs) {
    if (!['invoice', 'packing_list', 'contract'].includes(d.doc_type ?? '') || isDraft(d)) continue;
    const empty = emptyFieldsOf(d.fields);
    // Batch / date first: «Batch No.» is a batch field, not the document number.
    const minor = empty.filter((f) => BATCH_FIELD_RX.test(f) || DATE_FIELD_RX.test(f));
    const major = empty.filter((f) => !minor.includes(f) && (NUMBER_FIELD_RX.test(f) || CONSIGNEE_FIELD_RX.test(f)));
    if (major.length === 0 && minor.length === 0) continue;
    out.push({
      code: 'empty_fields',
      category: 'document_quality',
      severity: major.length ? 'warning' : 'info',
      title: `${label(d.doc_type!)}: не заповнено ключові поля`,
      detail: sentence(`«${name(d)}» — порожні поля: ${[...major, ...minor].join(', ')}`),
      source_file_id: d.file_id,
    });
  }
  return out;
}

/** Every document-integrity risk of the shipment (or lot), unsorted. */
export function documentRisks(docs: FlagDoc[]): Risk[] {
  return [...buyerBankRisks(docs), ...dangerousGoodsRisks(docs), ...certificateRisks(docs), ...emptyFieldRisks(docs)];
}
