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

// Regressions from the prod acceptance on «Сборник 18 Китай» (2026-10-22).
describe('computeFclLevel — Сборник 18 regressions', () => {
  const cmrZirka = file('cz', 'CMR Зирка.pdf', { doc_type: 'transport', transport_doc_kind: 'cmr', gross_weight_kg: 2240, container_numbers: ['ECMU4794246'] });
  const hA1 = file('a1', 'HBL-A (10).pdf', { doc_type: 'transport', transport_doc_kind: 'hbl', transport_doc_number: 'BW26010230A', consignor_name: 'Shandong Betaine Co Ltd', consignee_name: '"NOVALAIT" LLC', gross_weight_kg: 4040, packages_count: 4 });
  const hA2 = { ...hA1, file_id: 'a2', file_name: 'HBL-A TELEX.pdf' };
  const hB = file('b1', 'HBL-B (9).pdf', { doc_type: 'transport', transport_doc_kind: 'hbl', transport_doc_number: 'BW26010230B', consignor_name: 'Hebei Pharm Co Ltd', consignee_name: 'PRIME FORCE UK BUSINESS LIMITED', gross_weight_kg: 14, packages_count: 1 });
  const t1 = file('t', 'T1.pdf', { doc_type: 'transport', transport_doc_kind: 'transit', gross_weight_kg: 4054 });
  const exportDecl = file('e', 'Export Declaration.pdf', { doc_type: 'customs_declaration', transport_doc_number: 'CHN3007938P2', buyer: 'PRIME FORCE UK BUSINESS LIMITED' });
  const md = file('md', 'ВМД оформлена.pdf', { doc_type: 'customs_declaration', transport_doc_number: '26UA205140022085U4', consignee_name: 'ТОВ "НОВАЛАЙТ"', buyer: 'ТОВ "НОВАЛАЙТ"' });
  const resale = file('r', 'Прайм_ЧЗ инвойс.pdf', { doc_type: 'invoice', seller: 'PRIME FORCE UK BUSINESS LIMITED', buyer: 'PJSC Chervona Zirka' }, { lot_id: 'L2' });
  const base18 = { transport_mode: 'multimodal', eu_transit: null, consignee: null, lots: lots.map((l) => ({ ...l, consignee: null, recipient: 'PRIME FORCE UK BUSINESS LIMITED' })) };

  it('a CMR is no master bill when the cargo has house bills', () => {
    const v = computeFclLevel({ ...base18, files: [cmrZirka, hA1, hB] });
    expect(v.checklist.find((i) => i.requirement_key === 'master_transport')?.status).toBe('missing');
    expect(v.discrepancies.some((d) => d.field.startsWith('hbl_sum'))).toBe(false);
  });

  it('requires a house bill per lot whenever there are house bills (multimodal)', () => {
    const v = computeFclLevel({ ...base18, files: [hA1] });
    expect(v.checklist.filter((i) => i.requirement_key.startsWith('hbl:')).map((i) => i.status)).toEqual(['verified', 'missing']);
  });

  it('counts each house bill once, whatever the number of copies', () => {
    const v = computeFclLevel({ ...base18, files: [hA1, hA2, hB, t1] });
    // T1 4054 = HBL-A 4040 + HBL-B 14 — no transit discrepancy despite two HBL-A copies.
    expect(v.discrepancies.filter((d) => d.field.startsWith('transit'))).toEqual([]);
    const copy = { ...hA2, fields: { ...hA2.fields, gross_weight_kg: 3900 } };
    const w = computeFclLevel({ ...base18, files: [hA1, copy, hB] });
    expect(w.discrepancies.find((d) => d.field === 'hbl_versions_gross_weight_kg')?.kind).toBe('suspected');
  });

  it('one edited copy does not decide the sums: majority figures, findings only suspected', () => {
    const hC = (id: string, name: string, g: number) =>
      file(id, name, { doc_type: 'transport', transport_doc_kind: 'hbl', transport_doc_number: 'BW26010230C', consignor_name: 'Shandong Betaine Co Ltd', gross_weight_kg: g, packages_count: 4 });
    const t1c = file('t', 'T1.pdf', { doc_type: 'transport', transport_doc_kind: 'transit', gross_weight_kg: 10720 });
    const v = computeFclLevel({
      ...base18,
      files: [hC('c0', 'HBL-C TELEX edited.pdf', 10150), hC('c1', 'HBL-C (10).pdf', 10720), hC('c2', 'HBL-C TELEX.pdf', 10720), t1c],
    });
    expect(v.discrepancies.some((d) => d.field.startsWith('transit'))).toBe(false);
    const w = computeFclLevel({ ...base18, files: [hC('c0', 'HBL-C TELEX edited.pdf', 10150), hC('c1', 'HBL-C (10).pdf', 10720), hC('c2', 'HBL-C TELEX.pdf', 10720), { ...t1c, fields: { ...t1c.fields, gross_weight_kg: 9000 } }] });
    expect(w.discrepancies.find((d) => d.field.startsWith('transit'))?.kind).toBe('suspected');
  });

  it('takes consignees from house bills / resale invoices, never our own company', () => {
    const v = computeFclLevel({ ...base18, files: [hA1, hB, resale, exportDecl, md] });
    expect(v.lotConsignees).toEqual({ L1: '"NOVALAIT" LLC', L2: 'PJSC Chervona Zirka' });
    const mdItems = v.checklist.filter((i) => i.stage === 'customs').map((i) => `${i.label}:${i.status}`);
    expect(mdItems).toEqual(['МД — "NOVALAIT" LLC:verified', 'МД — PJSC Chervona Zirka:missing']);
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
