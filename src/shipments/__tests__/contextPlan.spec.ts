import { describe, expect, it } from 'vitest';
import { isIntakeComplete, planContextUpdate } from '../contextDerive.js';
import type { WorkspaceRow } from '../workspaceAccess.js';
import type { PartiesAnalysis } from '../../reconciliation/partyExtraction.js';

function ws(over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id: 'ws1', owner_id: 'u1', number: '1', supplier: '', status: 'draft', created_at: '',
    contract_type: null, intake_complete: false, product_category: null, incoterm: null,
    incoterm_in: null, incoterm_out: null, transport_mode: null, origin_country: null,
    destination_country: null, responsible_user_id: null, contract_type_source: null,
    contract_type_confidence: null, contract_type_reason: null, auto_context_fields: [],
    survey_answers: null, survey_status: 'not_started',
    ...over,
  };
}

const analysis = (over: Partial<PartiesAnalysis> = {}): PartiesAnalysis => ({
  suggestions: [],
  manufacturer: null,
  contract_type: null,
  contract_type_reason: '',
  contract_type_confidence: 0,
  ...over,
});

const invoiceFca = [{ file_name: 'inv.pdf', doc_type: 'invoice', fields: { incoterm: 'FCA Mumbai' } }];

describe('context autopilot plan', () => {
  it('fills an empty field and records it as autopilot-written (with the legacy mirror)', () => {
    const plan = planContextUpdate(ws(), analysis(), invoiceFca);
    expect(plan.columns.incoterm_in).toBe('FCA');
    expect(plan.columns.incoterm).toBe('FCA');
    expect(plan.written).toContain('incoterm_in');
  });

  it('never overwrites a manual edit', () => {
    const plan = planContextUpdate(ws({ incoterm_in: 'CPT' }), analysis(), invoiceFca);
    expect(plan.columns.incoterm_in).toBeUndefined();
  });

  it('a manual: marker wins even over an empty value', () => {
    const plan = planContextUpdate(ws({ auto_context_fields: ['manual:incoterm_in'] }), analysis(), invoiceFca);
    expect(plan.columns.incoterm_in).toBeUndefined();
  });

  it('refines a value it wrote itself', () => {
    const plan = planContextUpdate(ws({ incoterm_in: 'CPT', auto_context_fields: ['incoterm_in'] }), analysis(), invoiceFca);
    expect(plan.columns.incoterm_in).toBe('FCA');
  });

  it('treats a legacy free-text value as autopilot-written', () => {
    const plan = planContextUpdate(ws({ incoterm_in: 'CPT - Bila Tserkva' }), analysis(), invoiceFca);
    expect(plan.columns.incoterm_in).toBe('FCA');
  });

  it('an auto contract mode follows the documents; a manual one is never touched', () => {
    const trilateral = analysis({ contract_type: 'trilateral', contract_type_confidence: 0.9, contract_type_reason: 'r' });
    const auto = planContextUpdate(ws({ contract_type: 'bilateral', contract_type_source: 'auto', contract_type_confidence: 0.1 }), trilateral, []);
    expect(auto.columns.contract_type).toBe('trilateral');
    expect(auto.columns.contract_type_source).toBe('auto');
    const manual = planContextUpdate(ws({ contract_type: 'bilateral', contract_type_source: 'sidebar' }), trilateral, []);
    expect(manual.columns.contract_type).toBeUndefined();
  });

  it('never guesses the product category; seeds named parties', () => {
    const plan = planContextUpdate(
      ws(),
      analysis({ suggestions: [{ role: 'recipient', company_name: 'AGroup95', country: 'Україна' } as PartiesAnalysis['suggestions'][number], { role: 'sender', company_name: ' ', country: null } as PartiesAnalysis['suggestions'][number]] }),
      [],
    );
    expect(plan.columns.product_category).toBeUndefined();
    expect(plan.parties.map((p) => p.company_name)).toEqual(['AGroup95']);
  });
});

describe('intake completeness', () => {
  const full = { contract_type: 'bilateral' as const, product_category: 'api', incoterm_in: 'FCA', incoterm: null, transport_mode: 'air', origin_country: 'Індія' };
  it('needs all five', () => {
    expect(isIntakeComplete(full)).toBe(true);
    expect(isIntakeComplete({ ...full, origin_country: null })).toBe(false);
  });
  it('falls back to the legacy incoterm column', () => {
    expect(isIntakeComplete({ ...full, incoterm_in: null, incoterm: 'FCA' })).toBe(true);
  });
});
