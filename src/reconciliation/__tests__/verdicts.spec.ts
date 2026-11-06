import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../../lib/config.js', () => ({ config: {} }));

const { computeVerdicts } = await import('../verdicts.js');
type Snapshot = Parameters<typeof computeVerdicts>[0];

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10);

function snapshot(over: Partial<Snapshot> = {}, ws: Record<string, unknown> = {}): Snapshot {
  return {
    ws: {
      id: 'ws1', owner_id: 'u1', number: '1', supplier: 'S', status: 'docs_in_progress', created_at: '',
      contract_type: 'bilateral', intake_complete: true, product_category: null, incoterm: null,
      incoterm_in: null, incoterm_out: null, transport_mode: null, origin_country: null,
      destination_country: null, responsible_user_id: null, contract_type_source: null,
      contract_type_confidence: null, contract_type_reason: null, auto_context_fields: [],
      survey_answers: null, survey_status: 'not_started',
      ...ws,
    } as Snapshot['ws'],
    required: ['invoice', 'packing_list'],
    files: [],
    intermediary: null,
    approvedInstruction: null,
    registry: [],
    ...over,
  };
}

const file = (id: string, fields: Record<string, unknown> | null, folder: string | null = null) => ({
  file_id: id, file_name: `${id}.pdf`, folder_name: folder, fields,
});

describe('shipment verdicts', () => {
  it('feed goods need a veterinary certificate; a draft does not count', () => {
    const inv = { ...file('inv', { doc_type: 'invoice' }), feed_goods: true };
    const pl = file('pl', { doc_type: 'packing_list' });
    const missing = computeVerdicts(snapshot({ files: [inv, pl, { ...file('hc', null), file_name: 'draft HC.pdf', vet_certificate: true }] }), NOW);
    expect(missing.checklist.find((i) => i.requirement_key === 'veterinary_certificate')?.status).toBe('missing');
    expect(missing.derivedStatus).toBe('docs_in_progress');
    const got = computeVerdicts(snapshot({ files: [inv, pl, { ...file('hc', null), vet_certificate: true }] }), NOW);
    expect(got.checklist.find((i) => i.requirement_key === 'veterinary_certificate')).toMatchObject({ status: 'received', source_file_id: 'hc' });
    const noFeed = computeVerdicts(snapshot({ files: [file('inv', { doc_type: 'invoice' }), pl] }), NOW);
    expect(noFeed.checklist.some((i) => i.requirement_key === 'veterinary_certificate')).toBe(false);
  });

  describe('qdpro requirements for the goods УКТ ЗЕД code (cached)', () => {
    const CODE = '2922410000';
    const inv = file('inv', { doc_type: 'invoice', hs_code: '2922 41 00 00' });
    const pl = file('pl', { doc_type: 'packing_list' });
    const vetCached = [{ hs_code: CODE, requirements: [{ key: 'veterinary_certificate' as const, evidence: 'Ветеринарно-санітарний контроль' }] }];
    const vetItems = (v: ReturnType<typeof computeVerdicts>) => v.checklist.filter((i) => i.requirement_key === 'veterinary_certificate');

    it('a required document with no matching file is missing, with the qdpro basis', () => {
      const v = computeVerdicts(snapshot({ files: [inv, pl], hsRequirements: vetCached }), NOW);
      expect(vetItems(v)).toEqual([
        { requirement_key: 'veterinary_certificate', status: 'missing', source_file_id: null, basis: `вимога qdpro для коду ${CODE}` },
      ]);
      expect(v.derivedStatus).toBe('docs_in_progress');
      const risk = v.risks.find((r) => r.code === 'docs_missing');
      expect(risk?.detail).toContain('Ветеринарний сертифікат');
    });

    it('a file that reads as the document makes it received', () => {
      const hc = { ...file('hc', { doc_type: 'other' }), vet_certificate: true, requirement_hits: ['veterinary_certificate'] };
      const v = computeVerdicts(snapshot({ files: [inv, pl, hc], hsRequirements: vetCached }), NOW);
      expect(vetItems(v)).toEqual([expect.objectContaining({ status: 'received', source_file_id: 'hc' })]);
    });

    it('a draft does not count, nor a contract that merely lists the document', () => {
      const draft = { ...file('hc', null), file_name: 'HC draft.pdf', requirement_hits: ['phytosanitary_certificate'] };
      const contract = { ...file('k', { doc_type: 'contract' }), requirement_hits: ['phytosanitary_certificate'] };
      const phyto = [{ hs_code: CODE, requirements: [{ key: 'phytosanitary_certificate' as const, evidence: 'Фітосанітарний контроль' }] }];
      const v = computeVerdicts(snapshot({ files: [inv, pl, draft, contract], hsRequirements: phyto }), NOW);
      expect(v.checklist.find((i) => i.requirement_key === 'phytosanitary_certificate')?.status).toBe('missing');
    });

    it('feed goods + qdpro veterinary control → ONE veterinary row with both bases', () => {
      const feedInv = { ...inv, feed_goods: true };
      const v = computeVerdicts(snapshot({ files: [feedInv, pl], hsRequirements: vetCached }), NOW);
      expect(vetItems(v)).toHaveLength(1);
      expect(vetItems(v)[0]?.basis).toBe(`товар кормового призначення; вимога qdpro для коду ${CODE}`);
    });

    it('a cached code no file of this snapshot carries adds nothing (an FCL passes one list for all lots)', () => {
      const other = [{ hs_code: '1111111111', requirements: [{ key: 'import_license' as const, evidence: 'Ліцензування імпорту' }] }];
      const v = computeVerdicts(snapshot({ files: [inv, pl], hsRequirements: other }), NOW);
      expect(v.checklist.map((i) => i.requirement_key)).toEqual(['invoice', 'packing_list']);
    });

    it('no template requirements → no checklist at all, as for the feed item', () => {
      const v = computeVerdicts(snapshot({ required: [], files: [inv], hsRequirements: vetCached }), NOW);
      expect(v.checklist).toEqual([]);
    });
  });

  it('an empty shipment: everything missing, status in progress, one docs_missing risk', () => {
    const v = computeVerdicts(snapshot(), NOW);
    expect(v.checklist.map((i) => i.status)).toEqual(['missing', 'missing']);
    expect(v.derivedStatus).toBe('docs_in_progress');
    expect(v.risks.map((r) => r.code)).toEqual(['docs_missing']);
    expect(v.discrepancies).toEqual([]);
  });

  it('risks follow the freshly computed checklist, not a persisted one', () => {
    const v = computeVerdicts(
      snapshot({ files: [file('a', { doc_type: 'invoice' }), file('b', { doc_type: 'packing_list' })] }),
      NOW,
    );
    expect(v.checklist.every((i) => i.status === 'verified')).toBe(true);
    expect(v.risks.find((r) => r.code === 'docs_missing')).toBeUndefined();
    expect(v.derivedStatus).toBe('customs_ready');
  });

  it('a folder hint without an extraction is "received", which is docs_complete', () => {
    const v = computeVerdicts(
      snapshot({ files: [file('a', null, '01_Contract_Invoice_PackingList')] }),
      NOW,
    );
    expect(v.checklist.map((i) => i.status)).toEqual(['received', 'received']);
    expect(v.derivedStatus).toBe('docs_complete');
  });

  it('no matching templates → empty checklist, still in progress', () => {
    const v = computeVerdicts(snapshot({ required: [] }), NOW);
    expect(v.checklist).toEqual([]);
    expect(v.derivedStatus).toBe('docs_in_progress');
  });

  it('intake not complete → draft', () => {
    expect(computeVerdicts(snapshot({}, { intake_complete: false }), NOW).derivedStatus).toBe('draft');
  });

  it('delivery deadline pressure only while documents are missing', () => {
    const files = [file('a', { doc_type: 'invoice', delivery_deadline: iso(3) })];
    const v = computeVerdicts(snapshot({ files }), NOW);
    expect(v.risks.map((r) => r.code)).toContain('deadline_soon');
    const done = computeVerdicts(snapshot({ files, required: ['invoice'] }), NOW);
    expect(done.risks.map((r) => r.code)).not.toContain('deadline_soon');
  });

  it('a customs declaration in the package silences a passed deadline', () => {
    const files = [
      file('a', { doc_type: 'invoice', delivery_deadline: iso(-5) }),
      file('d', { doc_type: 'customs_declaration' }),
    ];
    expect(computeVerdicts(snapshot({ files }), NOW).risks.map((r) => r.code)).not.toContain('deadline_passed');
  });

  it('expired and expiring certificates', () => {
    const files = [
      file('c1', { doc_type: 'certificate_of_origin', expiry_date: iso(-1) }),
      file('c2', { doc_type: 'quality_certificate', expiry_date: iso(10) }),
    ];
    const codes = computeVerdicts(snapshot({ files }), NOW).risks.map((r) => r.code);
    expect(codes).toContain('cert_expired');
    expect(codes).toContain('cert_expiring');
  });

  it('registry findings and error discrepancies surface as risks, most severe first', () => {
    const files = [
      file('i', { doc_type: 'invoice', total_value: 1000, currency: 'USD' }),
      file('k', { doc_type: 'contract', total_value: 1000, currency: 'EUR' }),
    ];
    const v = computeVerdicts(
      snapshot({
        files,
        registry: [{ code: 'registry_expired', severity: 'error', title: 'T', detail: 'D', reg_number: 'UA/1' }],
      }),
      NOW,
    );
    expect(v.risks.some((r) => r.category === 'registry')).toBe(true);
    expect(v.risks.some((r) => r.category === 'discrepancy')).toBe(true);
    const ranks = v.risks.map((r) => ({ error: 0, warning: 1, info: 2 })[r.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('document-integrity checks: bank details, dangerous goods, certificates, blank fields', () => {
    // A fictional shipment: an advance and a final invoice of one seller with
    // different accounts at one bank, a pickup notice declaring UN 1940 that the
    // CMR omits, an unsigned health certificate, a blank batch number.
    const seller = 'Fictiva Chemicals GmbH';
    const bank = (iban: string) => ({ iban, swift: 'TESTDEFF', bank_name: 'Testbank AG', beneficiary: seller });
    const files = [
      file('adv', { doc_type: 'invoice', seller, buyer: 'TOV Zoriana Trade', currency: 'EUR', total_value: 300, bank_accounts: [bank('DE12500105170000062011')] }),
      file('inv', { doc_type: 'invoice', seller, buyer: 'TOV Zoriana Trade', currency: 'EUR', total_value: 1000, bank_accounts: [bank('DE12500105170000082011')], empty_fields: ['Batch No.'] }),
      file('pl', { doc_type: 'packing_list' }),
      file('pickup', { doc_type: 'other', dangerous_goods: { is_dangerous: true, un_number: 'UN 1940', adr_class: '8' } }),
      file('cmr', { doc_type: 'transport' }),
      { ...file('hc', { doc_type: 'other', signed: false, empty_fields: ['Consignee'] }), vet_certificate: true },
    ];
    const v = computeVerdicts(snapshot({ files }), NOW);
    const bankFinding = v.discrepancies.find((d) => d.field === 'bank_account');
    expect(bankFinding).toMatchObject({ severity: 'error', kind: 'confirmed' });
    expect(bankFinding!.citations).toHaveLength(2);
    const codes = v.risks.map((r) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'discrepancy_bank_account',
        'dangerous_goods',
        'dangerous_goods_undeclared',
        'certificate_incomplete',
        'empty_fields',
      ]),
    );
    expect(v.risks.find((r) => r.code === 'discrepancy_bank_account')!.title).toBe('Розбіжність: банківські реквізити');
    // An error-level discrepancy keeps the shipment in progress.
    expect(v.derivedStatus).toBe('docs_in_progress');
  });

  it('old extractions without the integrity fields add no new findings', () => {
    const files = [file('a', { doc_type: 'invoice', seller: 'S' }), file('b', { doc_type: 'invoice', seller: 'S' })];
    const v = computeVerdicts(snapshot({ files }), NOW);
    expect(v.discrepancies.some((d) => d.field === 'bank_account')).toBe(false);
    expect(v.risks.some((r) => ['payment', 'dangerous_goods', 'document_quality'].includes(r.category))).toBe(false);
  });
});
