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
});
