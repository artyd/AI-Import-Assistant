import type { Discrepancy } from '../reconcile.js';
import { incotermCode } from '../reconcile.js';
import { sameCompany } from '../contextDerive.js';
import type { InstructionDraft } from './types.js';

/**
 * Did the supplier follow our approved instruction? Pure check of the approved
 * draft against the stored extractions — no LLM, no re-reading of text. Runs
 * only once shipping documents exist (before that everything would be
 * "missing"). Findings join the discrepancy list under field `instruction`.
 */
export interface ComplianceDoc {
  file_id: string | null;
  file_name: string | null;
  doc_type: string | null;
  fields: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const CONSIGNEE_ROLE = /consignee|вантажоодерж|одержувач|получател|ship(ped)?\s*to/i;

/** Keywords that show a required document is present (doc_type and/or file name). */
const PRESENCE: Record<string, { types?: string[]; name?: RegExp }> = {
  invoice_pl: { types: ['invoice', 'packing_list'] },
  coo: { types: ['certificate_of_origin'], name: /\bcoo\b|origin|походж/i },
  coa: { types: ['quality_certificate'], name: /\bcoa\b|analys|аналіз/i },
  msds: { name: /msds|\bsds\b|safety data/i },
  export_decl: { name: /shipping\s*bill|export\s*decl|експортн|\bsb\b/i },
  insurance: { name: /insur|страх|полис|поліс/i },
  vet: { name: /veterin|ветерин/i },
  phyto: { name: /phyto|фіто/i },
  gmp: { name: /\bgmp\b/i },
};

const cite = (d: ComplianceDoc, value: string) => ({
  file_id: d.file_id,
  file_name: d.file_name,
  doc_type: d.doc_type ?? 'other',
  value,
});

export function checkInstructionCompliance(draft: InstructionDraft, docs: ComplianceDoc[], version: number): Discrepancy[] {
  const shipping = docs.filter(
    (d) => (d.doc_type === 'transport' && str(d.fields.transport_mode) !== 'courier') || d.doc_type === 'certificate_of_origin',
  );
  if (shipping.length === 0) return [];
  const out: Discrepancy[] = [];
  const tag = `інструкція v${version}`;

  // 1. Consignee in AWB / CMR / COO / packing list = the one we instructed.
  const want = draft.consignee.name.trim();
  if (want) {
    const wrong: { d: ComplianceDoc; name: string }[] = [];
    for (const d of docs) {
      if (!['transport', 'certificate_of_origin', 'packing_list'].includes(d.doc_type ?? '')) continue;
      if (str(d.fields.transport_mode) === 'courier') continue;
      const parties = Array.isArray(d.fields.parties) ? (d.fields.parties as { name?: string; role?: string }[]) : [];
      const consignee = parties.find((p) => p.role && CONSIGNEE_ROLE.test(p.role) && p.name);
      if (consignee?.name && !sameCompany(consignee.name, want)) wrong.push({ d, name: consignee.name });
    }
    if (wrong.length) {
      out.push({
        field: 'instruction',
        expected: `${tag}: consignee — ${want}`,
        actual: `у документах consignee — ${[...new Set(wrong.map((w) => w.name))].join(' / ')} (${wrong
          .map((w) => w.d.file_name ?? w.d.doc_type)
          .join(', ')})`,
        severity: 'error',
        kind: 'confirmed',
        citations: wrong.map((w) => cite(w.d, w.name)),
      });
    }
  }

  // 2. Incoterms on the supplier's invoice = instructed rule.
  const wantInc = incotermCode(draft.terms.incoterm);
  if (wantInc) {
    const supplierInv = docs.find(
      (d) => d.doc_type === 'invoice' && sameCompany(str(d.fields.seller), draft.consignor.name || null),
    );
    const got = incotermCode(str(supplierInv?.fields.incoterm));
    if (supplierInv && got && got !== wantInc) {
      out.push({
        field: 'instruction',
        expected: `${tag}: умови поставки ${wantInc} ${draft.terms.place}`.trim(),
        actual: `інвойс постачальника: ${str(supplierInv.fields.incoterm)}`,
        severity: 'warning',
        kind: 'confirmed',
        citations: [cite(supplierInv, String(supplierInv.fields.incoterm))],
      });
    }
  }

  // 3. Final destination as instructed (city token match, documents that state one).
  const wantDest = draft.terms.finalDestination.split(',')[0]!.trim().toLowerCase();
  if (wantDest) {
    const stated = docs
      .filter((d) => ['invoice', 'packing_list', 'transport'].includes(d.doc_type ?? '') && str(d.fields.transport_mode) !== 'courier')
      .map((d) => ({ d, v: str(d.fields.final_destination) }))
      .filter((x): x is { d: ComplianceDoc; v: string } => !!x.v);
    const off = stated.filter((x) => !x.v.toLowerCase().includes(wantDest));
    if (stated.length && off.length === stated.length) {
      out.push({
        field: 'instruction',
        expected: `${tag}: кінцевий пункт — ${draft.terms.finalDestination}`,
        actual: `у документах: ${[...new Set(off.map((x) => x.v))].join(' / ')}`,
        severity: 'warning',
        kind: 'suspected',
        citations: off.map((x) => cite(x.d, x.v)),
      });
    }
  }

  // 4. Every checked document is in the package.
  const missing: string[] = [];
  for (const item of draft.docs.filter((x) => x.checked)) {
    const rule = PRESENCE[item.key];
    if (!rule) continue; // custom / unknown item — not machine-checkable
    const present = docs.some(
      (d) =>
        (rule.types && rule.types.includes(d.doc_type ?? '')) ||
        (rule.name && rule.name.test(`${d.file_name ?? ''} ${str(d.fields.extraction_note) ?? ''}`)) ||
        (item.key === 'insurance' && str(d.fields.service_kind) === 'insurance'),
    );
    if (!present) missing.push(item.labelUk || item.label);
  }
  if (missing.length) {
    out.push({
      field: 'instruction',
      expected: `${tag}: документи за переліком`,
      actual: `не надано: ${missing.join(', ')}`,
      severity: 'warning',
      kind: 'suspected',
      citations: [],
    });
  }
  return out;
}
