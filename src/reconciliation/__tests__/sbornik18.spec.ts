import { describe, it, expect } from 'vitest';
import { reconcile, type ReconcileDoc } from '../reconcile.js';
import { findDiscrepancies } from '../discrepancies.js';
import { assessRisks } from '../risks.js';
import { documentRisks } from '../documentChecks.js';

/**
 * Regressions from the «Сборник 18» package — a consolidated container that was
 * cleared in Ukraine without problems, yet the checks reported a dozen «errors».
 * One pattern: documents that legitimately differ were compared as if they had
 * to agree — the two legs of an intermediated deal, a revised document and the
 * one it replaced, different suppliers' lots, and certificate dates against
 * today instead of the declaration day.
 */

function doc(name: string, doc_type: string, fields: Record<string, unknown>): ReconcileDoc {
  return { file_id: name, file_name: name, doc_type, fields };
}
const row = (description: string, quantity: number) => ({
  description, quantity, unit: 'kg', unit_price: null, amount: null, hs_code: null, batch_no: null,
});

const SUPPLIER = "Xi'an TaiCheng Chem Co., Ltd";
const PRIME = 'PRIME FORCE UK BUSINESS LIMITED';
const CONSIGNEE = 'PJSC Chervona Zirka';

// Supplier → Prime: aspartic acid + glucosamine in one PL / house bill.
const SUPPLIER_CONTRACT = doc('Additional Agreement No 1 Signed.pdf', 'contract', {
  seller: SUPPLIER, buyer: PRIME, total_value: 34400, currency: 'USD', incoterm: 'FCA Shanghai',
});
const SUPPLIER_INVOICE = doc('Commercial Invoice.pdf', 'invoice', {
  seller: SUPPLIER, buyer: PRIME, total_value: 34400, currency: 'USD', incoterm: 'FCA Shanghai', hs_code: '2922',
});
const SUPPLIER_PL = doc('PL.pdf', 'packing_list', {
  seller: SUPPLIER, buyer: PRIME, net_weight_kg: 10500, gross_weight_kg: 10720, packages_count: 420,
  line_items: [row('DL-Aspartic acid', 10000), row('D-Glucosamine HCl', 500)],
});
const HBL_TO_PRIME = doc('HBL-C TELEX.pdf', 'transport', {
  consignor_name: SUPPLIER, consignee_name: PRIME, gross_weight_kg: 10720, packages_count: 420,
});
// Prime → consignee: only the aspartic acid.
const RESALE_INVOICE = doc('Prime_CZ invoice aspartic.pdf', 'invoice', {
  seller: PRIME, buyer: CONSIGNEE, total_value: 65000, currency: 'USD', incoterm: 'CPT Bila Tserkva',
  net_weight_kg: 10000, gross_weight_kg: 10150, packages_count: 400, hs_code: '2922',
  line_items: [row('DL-Aspartic acid', 10000)],
});
const HBL_TO_CONSIGNEE = doc('HBL-C TELEX aspartic.pdf', 'transport', {
  consignor_name: 'Changzhou Shenlong', consignee_name: CONSIGNEE, gross_weight_kg: 10150, packages_count: 400,
});
const LOT = [SUPPLIER_CONTRACT, SUPPLIER_INVOICE, SUPPLIER_PL, HBL_TO_PRIME, RESALE_INVOICE, HBL_TO_CONSIGNEE];
const TRI = { contractMode: 'trilateral' as const, intermediaryName: PRIME };

describe('«Сборник 18»: two legs of one deal are not compared as one document', () => {
  it('the supplier contract is not checked against the resale invoice (value, Incoterms, parties)', () => {
    const out = reconcile(LOT, TRI);
    for (const f of ['total_value', 'incoterm', 'seller', 'buyer']) {
      expect(out.find((d) => d.field === f), f).toBeUndefined();
    }
  });

  it('the supplier contract IS checked against the supplier invoice of its own leg', () => {
    const wrong = { ...SUPPLIER_INVOICE, fields: { ...SUPPLIER_INVOICE.fields, total_value: 36000 } };
    const out = reconcile([SUPPLIER_CONTRACT, wrong, RESALE_INVOICE], TRI);
    expect(out.find((d) => d.field === 'total_value')?.severity).toBe('error');
  });

  it('cargo split between consignees: supplier leg 10 500 / resale leg 10 000 kg is a note, not a red error', () => {
    const out = reconcile(LOT, TRI);
    for (const f of ['net_weight_kg', 'gross_weight_kg', 'packages_count']) {
      const d = out.find((x) => x.field === f);
      expect(d?.severity, f).toBe('info');
      expect(d?.kind, f).toBe('suspected');
    }
    expect(out.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('a supplier PL with two goods is not line-counted against a one-line resale invoice', () => {
    expect(reconcile(LOT, TRI).find((d) => d.field === 'line_items')).toBeUndefined();
  });

  it('a gap INSIDE one leg is still red', () => {
    const badHbl = { ...HBL_TO_CONSIGNEE, fields: { ...HBL_TO_CONSIGNEE.fields, gross_weight_kg: 11000 } };
    const out = reconcile([SUPPLIER_PL, HBL_TO_PRIME, RESALE_INVOICE, badHbl], TRI);
    expect(out.find((d) => d.field === 'gross_weight_kg')?.severity).toBe('error');
  });

  it('a contract with the intermediary vs a supplier invoice addressed to the consignee: no buyer «mismatch»', () => {
    const contract = doc('sign back Contract.pdf', 'contract', { seller: 'Henan Chuange Industry Co.,Ltd.', buyer: PRIME, total_value: 5700, currency: 'USD' });
    const invoice = doc('INVOICE PACKING LIST.pdf', 'invoice', { seller: 'HENAN CHUANGE INDUSTRY CO.,LTD', buyer: 'NOVALAIT LLC', total_value: 5700, currency: 'USD' });
    expect(reconcile([contract, invoice], { intermediaryName: PRIME }).find((d) => d.field === 'buyer')).toBeUndefined();
  });
});

describe('«Сборник 18»: versions, consolidations, notes', () => {
  it('a revised invoice/PL replaces the original: 4080 vs 4040 kg is not flagged', () => {
    const orig = doc('086_INVOICE PACKING LIST.pdf', 'invoice', { net_weight_kg: 4000, gross_weight_kg: 4080, packages_count: 4 });
    const rev = doc('089_revised INVOICE PACKING LIST.pdf', 'invoice', { net_weight_kg: 4000, gross_weight_kg: 4040, packages_count: 4 });
    const hbl = doc('HBL-A.pdf', 'transport', { gross_weight_kg: 4040, packages_count: 4 });
    expect(reconcile([orig, rev, hbl]).find((d) => d.field === 'gross_weight_kg')).toBeUndefined();
  });

  it('a file named DRAFT does not argue with the issued one', () => {
    const draft = doc('DRAFT COO-2.pdf', 'certificate_of_origin', { net_weight_kg: 10 });
    const coo = doc('COO-final.pdf', 'certificate_of_origin', { net_weight_kg: 1000 });
    const inv = doc('inv.pdf', 'invoice', { net_weight_kg: 1000 });
    expect(reconcile([draft, coo, inv]).find((d) => d.field === 'net_weight_kg')).toBeUndefined();
  });

  it('several suppliers in ONE shipment: one consolidation note instead of cross-supplier «errors»', () => {
    const docs = [
      doc('A contract.pdf', 'contract', { seller: SUPPLIER, buyer: PRIME, total_value: 34400, currency: 'USD' }),
      doc('B contract.pdf', 'contract', { seller: "Anqiu Lu'an Pharmaceutical Co., Ltd.", buyer: PRIME, total_value: 6400, currency: 'USD' }),
      doc('A PL.pdf', 'packing_list', { net_weight_kg: 10500 }),
      doc('B invoice.pdf', 'invoice', { net_weight_kg: 2000, total_value: 24000, currency: 'USD' }),
    ];
    const ws = { kind: 'shipment' as const, contract_type: null, incoterm_in: null, incoterm: null, incoterm_out: null };
    const out = findDiscrepancies(docs, { ws, intermediary: PRIME, approvedInstruction: null });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ field: 'documents', severity: 'warning', kind: 'suspected' });
    expect(out[0]!.actual).toContain('Збірник');
    // A lot of a Збірник (kind 'fcl') is reconciled as usual.
    const lot = findDiscrepancies(docs, { ws: { ...ws, kind: 'fcl' }, intermediary: PRIME, approvedInstruction: null });
    expect(lot.length).toBeGreaterThan(1);
  });

  it('two manufacturers for two goods are not a «manufacturer mismatch»', () => {
    const pl = doc('PL.pdf', 'packing_list', { line_items: [row('DL-Aspartic acid', 10000), row('D-Glucosamine HCl', 500)] });
    const a = doc('CoA aspartic.pdf', 'quality_certificate', { manufacturer: 'Changzhou Shenlong Bio-Engineering Co., Ltd.' });
    const b = doc('CoA glucosamine.pdf', 'quality_certificate', { manufacturer: 'Jiangsu Aoxin Biotechnology' });
    expect(reconcile([pl, a, b]).find((d) => d.field === 'manufacturer')).toBeUndefined();
  });

  it('no HS code on a supplier invoice and duplicate copies are notes (info), not problems', () => {
    const a = doc('inv.pdf', 'invoice', { country_of_origin: 'CN' });
    const b = doc('inv copy.pdf', 'invoice', { country_of_origin: 'CN' });
    const out = reconcile([a, b]);
    expect(out.find((d) => d.field === 'hs_code')?.severity).toBe('info');
    expect(out.find((d) => d.field === 'documents' && d.actual.includes('знайдено'))?.severity).toBe('info');
  });
});

describe('«Сборник 18»: risks', () => {
  const NOW = Date.UTC(2026, 10, 13);
  const base = { missing: [], discrepancies: [], registry: [], now: NOW };
  const ext = (file_name: string, doc_type: string | null, extra: Record<string, string | null> = {}) => ({
    file_id: file_name, file_name, doc_type, expiry_date: null, shipment_date: null, delivery_deadline: null, ...extra,
  });

  it('a certificate that expired months after the goods were declared is not «прострочено»', () => {
    const r = assessRisks({
      ...base,
      extractions: [
        ext('VET.pdf', 'quality_certificate', { expiry_date: '2026-08-02' }),
        ext('MD.pdf', 'customs_declaration', { document_date: '2026-04-15' }),
      ],
    });
    expect(r.filter((x) => x.category === 'expiry')).toEqual([]);
  });

  it('a certificate already expired on the declaration day is still an error', () => {
    const r = assessRisks({
      ...base,
      extractions: [
        ext('VET.pdf', 'quality_certificate', { expiry_date: '2026-03-01' }),
        ext('MD.pdf', 'customs_declaration', { document_date: '2026-04-15' }),
      ],
    });
    expect(r.find((x) => x.code === 'cert_expired')?.severity).toBe('error');
  });

  it('a draft certificate is never checked for expiry; an undeclared shipment still is', () => {
    expect(assessRisks({ ...base, extractions: [ext('Health certificate draft.doc', 'other', { expiry_date: '2026-08-02' })] })).toEqual([]);
    const live = assessRisks({ ...base, extractions: [ext('Health certificate.pdf', 'other', { expiry_date: '2026-08-02' })] });
    expect(live[0]?.title).toBe('Документ прострочено');
  });

  it('a contract listing the buyer’s bank in its requisites is not a payment to the buyer', () => {
    const contract = doc('Kontrakt.pdf', 'contract', {
      seller: PRIME, buyer: 'NOVALAIT LLC', total_value: 37166.2,
      bank_accounts: [{ iban: 'UA000000000000000000000000000', swift: 'TESTUA2X', bank_name: 'Bank', beneficiary: 'NOVALAIT LLC' }],
    });
    expect(documentRisks([contract]).filter((r) => r.code === 'bank_beneficiary_buyer')).toEqual([]);
  });

  it('CoA transport fields and «(ні, заповнено)» entries are not blank fields', () => {
    const coa = doc('VET COA.pdf', 'quality_certificate', { empty_fields: ['Container No.', 'Seal No.', 'Date of Despatch'] });
    const coo = doc('COO.pdf', 'certificate_of_origin', { empty_fields: ['Consignee (ні, заповнено)'] });
    expect(documentRisks([coa, coo])).toEqual([]);
  });
});
