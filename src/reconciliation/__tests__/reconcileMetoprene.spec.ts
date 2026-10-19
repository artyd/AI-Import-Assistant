import { describe, it, expect } from 'vitest';
import { reconcile, incotermCode, isRegulatoryRegistration, type ReconcileDoc } from '../reconcile.js';

/**
 * Regression cases from the 2026-10-05 live test on a real trilateral shipment
 * (S-methoprene: NGL India → PRIME FORCE UK → ТЕХІНФОРМ ПЛЮС). Each test pins a
 * false positive or a missed finding the deterministic layer produced.
 */

function doc(name: string, doc_type: string, fields: Record<string, unknown>): ReconcileDoc {
  return { file_id: name, file_name: name, doc_type, fields };
}

const line = (quantity: number, extra: Record<string, unknown> = {}) => ({
  description: 'S-METHOPRENE',
  quantity,
  unit: 'kg',
  unit_price: null,
  amount: null,
  hs_code: null,
  batch_no: 'SMP/06/012/2026',
  ...extra,
});

const NGL_INVOICE = doc('INVOICE.pdf', 'invoice', {
  seller: 'NGL Fine-Chem Limited',
  buyer: 'PRIME FORCE UK BUSINESS LIMITED',
  total_value: 13125,
  currency: 'USD',
  incoterm: 'FCA Mumbai Airport, India',
  net_weight_kg: 25,
  gross_weight_kg: 31.85,
  packages_count: 3,
  line_items: [line(25, { amount: 13125 })],
});
const PRIME_INVOICE = doc('Inv PL S-METHOPRENE.pdf', 'invoice', {
  seller: 'PRIME FORCE UK BUSINESS LIMITED',
  buyer: 'TEKHINFORM PLUS LLC',
  total_value: 8750,
  currency: 'USD',
  incoterm: 'CPT Bila Tzerkva, Ukraine',
  net_weight_kg: 25,
  gross_weight_kg: 32,
  packages_count: 3,
  line_items: [line(25, { amount: 8750 })],
});
const PACKING = doc('PACKING LIST.pdf', 'packing_list', {
  net_weight_kg: 25,
  gross_weight_kg: 31.85,
  packages_count: 3,
  line_items: [line(10), line(10), line(5)],
});
const CONTRACT = doc('03062026PTM.pdf', 'contract', {
  seller: 'PRIME FORCE UK BUSINESS LIMITED',
  buyer: 'TEKHINFORM PLUS',
  total_value: 8750,
  currency: 'USD',
  incoterm: 'CPT - Bila Tserkva, Ukraine (INCOTERMS 2010)',
});
const AWB = doc('AIRWAY BILL.PDF', 'transport', {
  gross_weight_kg: 32,
  packages_count: 3,
  registration_number: 'AID0009199',
});
const T1 = doc('DEP-1.pdf', 'transport', {
  net_weight_kg: 32,
  gross_weight_kg: 32,
  packages_count: 3,
  registration_number: '26DE330296234194K2',
});
const MD = doc('26UA100100040301U3.pdf', 'customs_declaration', {
  net_weight_kg: 25,
  gross_weight_kg: 32,
  packages_count: 3,
  registration_number: '26UA100100040301U3',
});

const ALL = [CONTRACT, NGL_INVOICE, PRIME_INVOICE, PACKING, AWB, T1, MD];
const TRI = { contractMode: 'trilateral' as const, incotermIn: 'FCA', incotermOut: 'CPT' };

describe('reconcile — Метопрен live-test regressions', () => {
  it('packing list split per carton (10+10+5) is NOT a quantity mismatch vs the 25 kg invoice line', () => {
    const out = reconcile(ALL, TRI);
    expect(out.some((d) => d.field === 'line_items')).toBe(false);
    expect(out.some((d) => d.field === 'line_quantity')).toBe(false);
  });

  it('a real per-batch quantity gap is still caught after aggregation', () => {
    const pl = doc('PACKING LIST.pdf', 'packing_list', { line_items: [line(10), line(10)] });
    const out = reconcile([CONTRACT, PRIME_INVOICE, NGL_INVOICE, pl], TRI);
    const q = out.find((d) => d.field === 'line_quantity');
    expect(q?.severity).toBe('error');
    expect(q?.actual).toContain('20');
  });

  it('gross 31.85 vs 32 across invoice/PL/AWB/T1/МД is surfaced as a grouped warning', () => {
    const out = reconcile(ALL, TRI);
    const g = out.find((d) => d.field === 'gross_weight_kg');
    expect(g?.severity).toBe('warning');
    const text = `${g?.expected} ${g?.actual}`;
    expect(text).toContain('31.85');
    expect(text).toContain('AIRWAY BILL.PDF');
    expect(text).toContain('26UA100100040301U3.pdf');
  });

  it('T1 with net = gross (32) vs net 25 elsewhere is a RED net-weight finding', () => {
    const out = reconcile(ALL, TRI);
    const n = out.find((d) => d.field === 'net_weight_kg');
    expect(n?.severity).toBe('error');
    expect(n?.actual).toContain('DEP-1.pdf');
  });

  it('same places count everywhere → no packages finding', () => {
    expect(reconcile(ALL, TRI).some((d) => d.field === 'packages_count')).toBe(false);
  });

  it('Incoterms with the same rule but a differently spelled place are not a mismatch', () => {
    const out = reconcile(ALL, TRI);
    expect(out.some((d) => d.field === 'incoterm')).toBe(false);
  });

  it('a different Incoterms rule between invoice and contract is still flagged', () => {
    const c = doc('c.pdf', 'contract', { ...CONTRACT.fields, incoterm: 'DAP Kyiv' });
    const out = reconcile([c, PRIME_INVOICE, NGL_INVOICE, PACKING], TRI);
    expect(out.some((d) => d.field === 'incoterm')).toBe(true);
  });

  it('AWB / MRN / МД numbers are not treated as drug registrations', () => {
    expect(reconcile(ALL, TRI).some((d) => d.field === 'registration_number')).toBe(false);
  });

  it('two different drug registrations on product documents are still flagged', () => {
    const a = doc('label.pdf', 'packing_list', { registration_number: 'UA/19603/01/01' });
    const b = doc('coa.pdf', 'quality_certificate', { registration_number: 'UA/19604/01/01' });
    expect(reconcile([a, b]).some((d) => d.field === 'registration_number')).toBe(true);
  });

  it('manufacturer on an unrelated (other) document is ignored; Limited/LIMITED spelling is one name', () => {
    const coa = doc('COA.pdf', 'quality_certificate', { manufacturer: 'NGL FINE-CHEM LIMITED' });
    const inv = doc('INVOICE.pdf', 'invoice', { manufacturer: 'NGL Fine-Chem Ltd' });
    const foreign = doc('RC_Eprinil.jpg', 'other', { manufacturer: 'ТОВ «Бровафарма»' });
    expect(reconcile([coa, inv, foreign]).some((d) => d.field === 'manufacturer')).toBe(false);
  });

  it('a genuine manufacturer mismatch names the variants and their files', () => {
    const coa = doc('COA.pdf', 'quality_certificate', { manufacturer: 'NGL Fine-Chem Limited' });
    const lbl = doc('label.pdf', 'packing_list', { manufacturer: 'Sujata Chemicals' });
    const m = reconcile([coa, lbl]).find((d) => d.field === 'manufacturer');
    expect(m?.actual).toContain('Sujata Chemicals');
    expect(m?.actual).toContain('COA.pdf');
  });

  it('with several same-type files, the issued PDF is reconciled, not the .doc draft, and the note names files', () => {
    const draft = doc('PL S-METHOPRENE.doc', 'packing_list', { line_items: [line(7)] });
    const out = reconcile([draft, CONTRACT, PRIME_INVOICE, NGL_INVOICE, PACKING], TRI);
    expect(out.some((d) => d.field === 'line_quantity')).toBe(false);
    const note = out.find((d) => d.field === 'documents' && d.actual.includes('packing_list'));
    expect(note?.actual).toContain('PACKING LIST.pdf');
    expect(note?.actual).toContain('PL S-METHOPRENE.doc');
  });

  it('invoice legs are oriented by the shipment intermediary, not a hardcoded company', () => {
    const inbound = doc('in.pdf', 'invoice', { seller: 'Maker SA', buyer: 'Acme Trading LLP', total_value: 900, currency: 'USD' });
    const outbound = doc('out.pdf', 'invoice', { seller: 'Acme Trading LLP', buyer: 'ТОВ Імпортер', total_value: 1000, currency: 'USD' });
    const out = reconcile([outbound, inbound], { contractMode: 'trilateral', intermediaryName: 'ACME TRADING' });
    expect(out.find((d) => d.field === 'markup')?.severity).toBe('info');
    expect(out.some((d) => d.field === 'intermediary')).toBe(false);
  });

  it('helpers', () => {
    expect(incotermCode('CPT - BILA TSERKVA, UKRAINE (INCOTERMS 2010)')).toBe('CPT');
    expect(incotermCode('FCA BY AIR MUMBAI AIRPORT')).toBe('FCA');
    expect(incotermCode('по домовленості')).toBeNull();
    expect(isRegulatoryRegistration('UA/19603/01/01')).toBe(true);
    expect(isRegulatoryRegistration('АВ-09881-03-25')).toBe(true);
    expect(isRegulatoryRegistration('AID0009199')).toBe(false);
    expect(isRegulatoryRegistration('IM/2026/016/0706761A/00027055')).toBe(false);
  });
});

describe('reconcile — review follow-ups', () => {
  it('a places gap that only involves a transport document is YELLOW (pallets vs cartons)', () => {
    const awb = doc('AWB.pdf', 'transport', { packages_count: 1 });
    const out = reconcile([PRIME_INVOICE, PACKING, awb]);
    expect(out.find((x) => x.field === 'packages_count')?.severity).toBe('warning');
  });

  it('a places gap among commercial documents / МД is RED', () => {
    const md = doc('MD.pdf', 'customs_declaration', { packages_count: 4 });
    const out = reconcile([PRIME_INVOICE, PACKING, md]);
    expect(out.find((x) => x.field === 'packages_count')?.severity).toBe('error');
  });

  it('a superseded .doc draft does not create a weight finding next to the issued PDF', () => {
    const draft = doc('PL S-METHOPRENE.doc', 'packing_list', { gross_weight_kg: 40 });
    const out = reconcile([PACKING, draft, NGL_INVOICE]);
    expect(out.some((x) => x.field === 'gross_weight_kg')).toBe(false);
  });

  it('very short intermediary names never orient legs by substring', () => {
    const inv = doc('i.pdf', 'invoice', { seller: 'Agro Trade', buyer: 'X', total_value: 1, currency: 'USD' });
    const out = reconcile([inv], { contractMode: 'trilateral', intermediaryName: 'AG' });
    expect(out.some((x) => x.field === 'intermediary')).toBe(true);
  });
});
