import { describe, expect, it } from 'vitest';
import { computeFclLevel, deriveEuTransit, matchHblsToLots, worstStatus, type FclFile, type FclLot } from '../fcl.js';

const file = (id: string, name: string, fields: Record<string, unknown> | null, extra: Partial<FclFile> = {}): FclFile => ({
  file_id: id,
  file_name: name,
  file_type: 'pdf',
  folder_name: '02_Транспорт',
  lot_id: null,
  fields,
  ...extra,
});

const lots: FclLot[] = [
  { id: 'L1', name: 'Shandong', supplier_name: 'Shandong Betaine Co Ltd', consignee: 'НОВАЛАЙТ', derivedStatus: 'docs_complete' },
  { id: 'L2', name: 'Hebei', supplier_name: 'Hebei Pharm Co Ltd', consignee: 'Червона Зірка', derivedStatus: 'docs_complete' },
];

const mbl = file('m', 'MBL.pdf', {
  doc_type: 'transport',
  transport_doc_kind: 'mbl',
  container_numbers: ['ECMU4794246'],
  gross_weight_kg: 10000,
  packages_count: 20,
  place_of_discharge: 'Gdansk, Poland',
});
const hblA = file('a', 'HBL A.pdf', { doc_type: 'transport', transport_doc_kind: 'hbl', consignor_name: 'SHANDONG BETAINE CO., LTD', container_numbers: ['ECMU4794246'], gross_weight_kg: 6000, packages_count: 12 });
const hblB = file('b', 'HBL B.pdf', { doc_type: 'transport', transport_doc_kind: 'hbl', seller: 'Hebei Pharm Co Ltd', container_numbers: ['ECMU4794246'], gross_weight_kg: 4000, packages_count: 8 });
const t1 = file('t', 'T1.pdf', { doc_type: 'transport', transport_doc_kind: 'transit', gross_weight_kg: 10000 });
const cmr = file('c', 'CMR.pdf', { doc_type: 'transport', transport_doc_kind: 'cmr' });
const manifest = file('x', 'manifest.xlsx', null, { file_type: 'xlsx', folder_name: '01_Маніфест' });
const pl1 = file('p1', 'PL1.pdf', { doc_type: 'packing_list', gross_weight_kg: 6000 }, { lot_id: 'L1', folder_name: 'Партія — Shandong' });
const mdNova = file('d1', 'MD.pdf', { doc_type: 'customs_declaration', buyer: 'ТОВ НОВАЛАЙТ' }, { folder_name: '03_Митниця' });

const base = { transport_mode: 'sea', eu_transit: null, consignee: null, lots };

describe('computeFclLevel', () => {
  it('a full FCL package: everything verified, waiting only for the second МД', () => {
    const v = computeFclLevel({ ...base, files: [mbl, hblA, hblB, t1, cmr, manifest, pl1, mdNova] });
    expect(v.hblLot).toEqual({ a: 'L1', b: 'L2' });
    expect(v.euTransit).toBe(true);
    expect(v.discrepancies).toEqual([]);
    const missing = v.checklist.filter((i) => i.status === 'missing').map((i) => i.label);
    expect(missing).toEqual(['МД — Червона Зірка']);
    expect(v.levelStatus).toBe('docs_complete');
    expect(v.derivedStatus).toBe('docs_complete');
    expect(v.containers).toEqual(['ECMU4794246']);
  });

  it('flags Σ HBL ≠ MBL and a foreign container as confirmed', () => {
    const lightB = { ...hblB, fields: { ...hblB.fields, gross_weight_kg: 3000, container_numbers: ['MSCU1234567'] } };
    const v = computeFclLevel({ ...base, files: [mbl, hblA, lightB, t1, cmr, manifest] });
    const fields = v.discrepancies.map((d) => `${d.field}:${d.kind}`);
    expect(fields).toContain('container_numbers:confirmed');
    expect(fields).toContain('hbl_sum_gross_weight_kg:confirmed');
    expect(v.levelStatus).toBe('docs_in_progress');
  });

  it('a low-confidence read is only suspected', () => {
    const shaky = { ...hblB, fields: { ...hblB.fields, gross_weight_kg: 3000, field_confidence: { gross_weight_kg: 'low' } } };
    const v = computeFclLevel({ ...base, files: [mbl, hblA, shaky] });
    const d = v.discrepancies.find((x) => x.field === 'hbl_sum_gross_weight_kg');
    expect(d?.kind).toBe('suspected');
  });

  it('checks a lot packing list against its house bill', () => {
    const heavyPl = { ...pl1, fields: { doc_type: 'packing_list', gross_weight_kg: 7000 } };
    const v = computeFclLevel({ ...base, files: [mbl, hblA, hblB, heavyPl] });
    expect(v.discrepancies.some((d) => d.field === 'lot_gross_weight_kg')).toBe(true);
  });

  it('counts files outside lots and FCL folders as unassigned', () => {
    const stray = file('s', 'coa.pdf', { doc_type: 'quality_certificate' }, { folder_name: null });
    const v = computeFclLevel({ ...base, files: [mbl, stray] });
    expect(v.unassigned).toBe(1);
    expect(v.risks.some((r) => r.code === 'fcl_unassigned_files')).toBe(true);
  });

  it('the FCL status is the worst lot', () => {
    const v = computeFclLevel({
      ...base,
      lots: [lots[0]!, { ...lots[1]!, derivedStatus: 'docs_in_progress' }],
      files: [mbl, hblA, hblB, t1, cmr, manifest, mdNova],
    });
    expect(v.derivedStatus).toBe('docs_in_progress');
  });
});

describe('helpers', () => {
  it('worstStatus', () => {
    expect(worstStatus(['customs_ready', 'docs_complete', 'customs_ready'])).toBe('docs_complete');
    expect(worstStatus(['customs_ready'])).toBe('customs_ready');
  });

  it('EU transit: explicit wins, else from the discharge port', () => {
    expect(deriveEuTransit(false, [mbl])).toBe(false);
    expect(deriveEuTransit(null, [mbl])).toBe(true);
    expect(deriveEuTransit(null, [file('m2', 'MBL.pdf', { doc_type: 'transport', transport_doc_kind: 'mbl', place_of_discharge: 'Odesa' })])).toBe(false);
    expect(deriveEuTransit(null, [])).toBeNull();
  });

  it('matches a house bill by goods when the shipper is unknown', () => {
    const inv = file('i', 'inv.pdf', { doc_type: 'invoice', product_name: 'Betaine anhydrous' }, { lot_id: 'L1' });
    const hbl = file('h', 'HBL.pdf', { doc_type: 'transport', transport_doc_kind: 'hbl', product_name: 'BETAINE ANHYDROUS 98%' });
    expect(matchHblsToLots([inv, hbl], lots)).toEqual({ h: 'L1' });
  });
});
