import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../../lib/config.js', () => ({ config: {} }));

const { computeVerdicts, hsRequirementItems } = await import('../verdicts.js');
const { qdproMeasures, requirementsFromQdpro } = await import('../../customs/qdproRequirements.js');
const { isFeedEvidence } = await import('../feed.js');
const { reconcile } = await import('../reconcile.js');
const { findDiscrepancies } = await import('../discrepancies.js');
const { documentRisks } = await import('../documentChecks.js');
const { registryChecksForDocs } = await import('../../customs/drugRegistry.js');
const { checkInstructionCompliance } = await import('../../instruction/compliance.js');
const { emptyDraft } = await import('../../instruction/defaults.js');
const { invoiceLines } = await import('../manifest.js');

/**
 * Audit 2026-11-13 (after «Сборник 18»): every check below produced a problem on
 * real prod packages that were in order. Shaped like those packages, anonymised.
 */

type Snapshot = Parameters<typeof computeVerdicts>[0];
const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY = 86_400_000;
const iso = (d: number) => new Date(NOW + d * DAY).toISOString().slice(0, 10);
function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    ws: {
      id: 'ws1', owner_id: 'u1', number: '1', supplier: 'S', status: 'docs_in_progress', created_at: '',
      contract_type: 'bilateral', intake_complete: true, product_category: null, incoterm: null,
      incoterm_in: null, incoterm_out: null, transport_mode: null, origin_country: null,
      destination_country: null, responsible_user_id: null, contract_type_source: null,
      contract_type_confidence: null, contract_type_reason: null, auto_context_fields: [],
      survey_answers: null, survey_status: 'not_started', kind: 'shipment',
    } as Snapshot['ws'],
    required: ['invoice', 'packing_list'],
    files: [],
    intermediary: null,
    approvedInstruction: null,
    registry: [],
    ...over,
  };
}
const file = (id: string, fields: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  file_id: id, file_name: `${id}.pdf`, folder_name: null, fields, ...extra,
});

// The real qdpro ІМПОРТ layout (numbered measures), shortened.
const LYSINE_IMPORT = [
  '- **ПДВ**: ставка 20 %.',
  '- Ліцензування, квоти, заборони, заходи контролю (з кодами документів), технічні регламенти, наркотичні засоби/прекурсори, подвійне використання: у цьому фрагменті не вказано.',
  '- **12. Наркотичні засоби, психотропні речовини, прекурсори** (діє з 01.06.2012). Потрібен один з документів:',
  '  - 5066: дозвіл на право ввезення (вивезення) чи транзиту наркотичних засобів, психотропних речовин або прекурсорів;',
  '  - 5069: заява декларанта про відсутність у товарах наркотичних засобів, психотропних речовин або прекурсорів.',
  '- **14. Заходи техрегламенту** (з 01.01.2026 до 31.12.2026):',
  '  - код 5123: документація згідно з вимогами до нехарчової продукції, встановленими технічними регламентами;',
  '  - контроль здійснюється при спрацюванні профілю ризику «Державний контроль нехарчової продукції».',
  '- **18. Нормативи відбору проб і зразків** (з 13.01.2017):',
  '  - коментар: органічні хімічні сполуки; субстанції фармацевтичні та ветеринарні.',
].join('\n');
const HORMONE_VET = [
  '**13. Ветеринарно-санітарний контроль**',
  '- 0853 — копія міжнародного ветеринарного сертифіката;',
  '- Коментар: гормони, що використовуються у ветеринарній медицині та тваринництві.',
].join('\n');

describe('qdpro measures: conditional measures are not missing documents', () => {
  it('precursor (5069 alternative), techregulation (5123), a sampling note and «не вказано» → nothing required', () => {
    expect(requirementsFromQdpro(LYSINE_IMPORT)).toEqual([]);
    const m = qdproMeasures(LYSINE_IMPORT);
    expect(m.map((x) => x.key)).not.toContain('veterinary_certificate');
    expect(m.find((x) => x.key === 'precursor_permit')?.conditional).toContain('5069');
    expect(m.find((x) => x.key === 'conformity_document')?.conditional).toBeTruthy();
  });

  it('vet control limited to veterinary use is conditional; a plain vet measure still binds', () => {
    expect(requirementsFromQdpro(HORMONE_VET)).toEqual([]);
    expect(requirementsFromQdpro('**13. Ветеринарно-санітарний контроль**\n- 5514 — кормові добавки')).toEqual(['veterinary_certificate']);
  });

  it('the checklist skips conditional requirements', () => {
    const items = hsRequirementItems({
      files: [file('inv', { doc_type: 'invoice', hs_code: '2922410000' })],
      hsRequirements: [{ hs_code: '2922410000', requirements: qdproMeasures(LYSINE_IMPORT) }],
    });
    expect(items).toEqual([]);
  });

  it('an unrelated file’s code brings no requirements', () => {
    const items = hsRequirementItems({
      files: [file('reg', { doc_type: 'other', hs_code: '3004900000' })],
      hsRequirements: [{ hs_code: '3004900000', requirements: [{ key: 'import_license', evidence: 'Ліцензування імпорту', rev: 2 }] }],
    });
    expect(items).toEqual([]);
  });
});

describe('feed goods', () => {
  it('an MSDS «keep away from animal feedingstuffs» does not make an insecticide feed', () => {
    expect(isFeedEvidence('quality_certificate', 'S-METHOPRENE MSDS.pdf')).toBe(false);
    expect(isFeedEvidence('other', 'label.jpg')).toBe(false);
    expect(isFeedEvidence('invoice', 'invoice.pdf')).toBe(true);
    const v = computeVerdicts(snapshot({ files: [{ ...file('MSDS', { doc_type: 'quality_certificate' }), feed_goods: true }] }), NOW);
    expect(v.checklist.map((i) => i.requirement_key)).not.toContain('veterinary_certificate');
  });
});

describe('export declarations are not the Ukrainian МД', () => {
  it('a Chinese export declaration does not hide a passed delivery deadline', () => {
    const files = [
      file('inv', { doc_type: 'invoice', delivery_deadline: iso(-5) }),
      { ...file('d', { doc_type: 'customs_declaration', transport_doc_number: 'CHN3007938P2' }), file_name: '报关单 export.pdf' },
    ];
    const v = computeVerdicts(snapshot({ files, required: ['invoice', 'packing_list'] }), NOW);
    expect(v.risks.map((r) => r.code)).toContain('deadline_passed');
  });
});

describe('names, terms and optional fields', () => {
  it('«NGL Fine-Chem Limited, India» and «NGL FINE CHEM LIMITED, Індія» are one manufacturer', () => {
    const a = { file_id: 'a', file_name: 'COA.pdf', doc_type: 'quality_certificate', fields: { manufacturer: 'NGL Fine-Chem Limited, India' } };
    const b = { file_id: 'b', file_name: 'MD.pdf', doc_type: 'customs_declaration', fields: { manufacturer: 'NGL FINE CHEM LIMITED, Індія' } };
    expect(reconcile([a, b]).find((d) => d.field === 'manufacturer')).toBeUndefined();
  });

  it('trilateral: the shipment’s CPT is not taken as the buy-side Incoterm', () => {
    const inbound = { file_id: 'i', file_name: 'INVOICE.pdf', doc_type: 'invoice', fields: { seller: 'NGL Fine-Chem', buyer: 'PRIME FORCE UK BUSINESS LIMITED', incoterm: 'FCA Mumbai Airport' } };
    const ws = { kind: 'shipment' as const, contract_type: 'trilateral' as const, incoterm: 'CPT Bila Tserkva', incoterm_in: null, incoterm_out: null };
    const out = findDiscrepancies([inbound], { ws, intermediary: 'PRIME FORCE UK BUSINESS LIMITED', approvedInstruction: null });
    expect(out.find((d) => d.field === 'incoterm')).toBeUndefined();
  });

  it('blank LC / vessel / other-reference boxes on an invoice are not «key fields»', () => {
    const inv = { file_id: 'i', file_name: 'inv.pdf', doc_type: 'invoice', fields: { empty_fields: ['Other Ref. No', 'Vessel Flight No', 'LC NO.'] } };
    expect(documentRisks([inv])).toEqual([]);
    const real = { ...inv, fields: { empty_fields: ['Invoice No.', 'LC NO.'] } };
    expect(documentRisks([real])[0]?.severity).toBe('warning');
  });
});

describe('drug registry', () => {
  const rec = {
    reg_number: 'UA/12345/01/01', product_name: 'X', active_substance: 'X', dosage_form: null,
    manufacturer: null, manufacturer_country: null, mah_owner: 'ТОВ "БІОФАРМА ПЛЮС"',
    valid_unlimited: false, valid_from: '2021-01-01', valid_to: '2026-06-01',
  };
  it('validity is judged on the МД date; the owner matches across legal forms', async () => {
    const docs = [
      { file_name: 'coa.pdf', fields: { doc_type: 'quality_certificate', registration_number: 'UA/12345/01/01' } },
      { file_name: 'МД.pdf', fields: { doc_type: 'customs_declaration', transport_doc_number: '26UA000000000001U1', document_date: '2026-04-15', buyer: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "БІОФАРМА ПЛЮС"' } },
    ];
    const out = await registryChecksForDocs(docs, async () => rec as never);
    expect(out.map((f) => f.code)).toEqual([]);
  });
});

describe('instruction compliance', () => {
  const doc = (file_name: string, doc_type: string, fields: Record<string, unknown>) => ({ file_id: file_name, file_name, doc_type, fields });
  it('«Paracetamol_SDS.pdf» is an MSDS; KIEV is Kyiv; a draft bill does not decide the consignee', () => {
    const d = emptyDraft();
    d.consignee = { name: 'PRIME FORCE UK BUSINESS LIMITED', address: '', country: '' };
    d.terms = { incoterm: 'FCA', place: 'Mumbai', destination: 'Kyiv', finalDestination: 'Kyiv, Ukraine', transport: 'air' };
    d.docs = d.docs.map((x) => ({ ...x, checked: x.key === 'msds' }));
    const docs = [
      doc('AWB.pdf', 'transport', { transport_mode: 'air', final_destination: 'KIEV', parties: [{ name: 'PRIME FORCE UK BUSINESS LIMITED', role: 'Consignee' }] }),
      doc('DRAFT AWB.pdf', 'transport', { transport_mode: 'air', parties: [{ name: 'OLD CONSIGNEE LLC', role: 'Consignee' }] }),
      doc('Paracetamol_SDS.pdf', 'quality_certificate', {}),
    ];
    expect(checkInstructionCompliance(d, docs, 1)).toEqual([]);
  });
});

describe('Збірник: labels, invoice copies, unitless lines', () => {

  it('a drum label filed as a packing list does not argue with the lot weights', () => {
    const pl = { file_id: 'p', file_name: 'Packing List - 291.pdf', doc_type: 'packing_list', fields: { net_weight_kg: 450, gross_weight_kg: 521.58 } };
    const inv = { file_id: 'i', file_name: 'Invoice 291.pdf', doc_type: 'invoice', fields: { net_weight_kg: 450, gross_weight_kg: 521.58 } };
    const label = { file_id: 'l', file_name: 'Draft Label.pdf', doc_type: 'packing_list', fields: { net_weight_kg: 25, gross_weight_kg: 28.95 } };
    const photo = { file_id: 'f', file_name: 'IMG_7216.jpeg', doc_type: 'packing_list', fields: { net_weight_kg: 25 } };
    expect(reconcile([pl, inv, label, photo]).filter((d) => /weight/.test(d.field))).toEqual([]);
  });

  it('manifest lines: one per invoice (copies, page scans, drafts out); a unitless quantity is not kilograms', () => {
    const fields = (qty: number, unit: string | null) => ({
      doc_type: 'invoice', invoice_number: 'SGSN-25351', seller: 'Qingdao Singsino Group',
      line_items: [{ description: 'Povidone K-30', quantity: qty, unit, unit_price: 6.3, amount: 6300, hs_code: null, batch_no: null }],
    });
    const files = [
      { file_id: 'a', file_name: '25351--CI&PL.pdf', lot_id: 'L', fields: fields(1000, 'kg') },
      { file_id: 'b', file_name: '25351--CI&PL(1).pdf', lot_id: 'L', fields: fields(1000, 'kg') },
      { file_id: 'c', file_name: '25351--CI&PL_Страница_1.jpg', lot_id: 'L', fields: fields(1000, 'kg') },
      { file_id: 'd', file_name: '25351 invoice draft.docx', lot_id: 'L', fields: fields(900, 'kg') },
    ];
    expect(invoiceLines(files, { L: 'Lot' })).toHaveLength(1);
    const drums = invoiceLines([{ file_id: 'x', file_name: 'inv.pdf', lot_id: 'L', fields: fields(40, null) }], { L: 'Lot' });
    expect(drums[0]?.qty_kg).toBeNull();
  });
});
