import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/config.js', () => ({ config: { LOGIST_MCP_URL: 'http://logist' } }));

import { buildConsolidatedSystemPrompt, buildNormalSystemPrompt, buildSystemPrompt } from '../systemPrompt.js';

const text = (s: unknown): string =>
  typeof s === 'string' ? s : (s as { text: string }[]).map((b) => b.text).join('\n');
const bytes = (s: unknown): number => Buffer.byteLength(text(s));

const shipment = buildSystemPrompt({
  number: '1',
  supplier: 'ACME',
  contract_type: 'trilateral',
  contract_type_source: 'auto',
  contract_type_confidence: 0.8,
  survey_status: null,
  parties: [],
  documentsDigest: '',
});
const consolidated = buildConsolidatedSystemPrompt({ number: '18', lots: [] });
const normal = buildNormalSystemPrompt();

// Byte sizes of the same sample inputs before the spec-010 rewrite.
const BEFORE = { shipment: 39406, normal: 19563, consolidated: 40530 };

describe('system prompt content (grounding contract, ADR-0003/0004)', () => {
  const p = text(shipment);
  it.each([
    ['rule 1: get_missing_context before instruction/discrepancies/HS/report', 'виклич get_missing_context'],
    ['rule 1: ask instead of assuming', 'спитай і зупинись'],
    ['rule 2: verdicts from tools', 'get_checklist'],
    ['rule 2: discrepancies tool', 'get_discrepancies'],
    ['rule 2: report tool', 'generate_report'],
    ['rule 2: retrieval only locates text', 'лише знаходять і цитують'],
    ['rule 3: several HS candidates', 'КІЛЬКА кандидатів'],
    ['rule 3: specialist confirms', 'підтверджує митний брокер'],
    ['rule 4: qdpro is the source', 'qdpro'],
    ['rule 4: static tables are a named fallback', 'запасний'],
    ['verify_facts rule', 'виклич verify_facts зі списком значень і файлів'],
    ['find_files before asserting absence', 'find_files щонайменше двічі'],
    ['empty data', 'немає даних'],
    ['details prompt', 'Детальніше?'],
    ['refuted finding', 'Розбіжності немає: <поле> — <чому>'],
  ])('%s', (_n, phrase) => {
    expect(p).toContain(phrase);
  });

  it('drops the contradicting «not short for the sake of brevity» line', () => {
    for (const s of [shipment, consolidated, normal]) expect(text(s)).not.toContain('Не коротка заради стислості');
  });

  it('the normal chat keeps advisory HS and no-fabrication', () => {
    expect(text(normal)).toContain('КІЛЬКА кандидатів');
    expect(text(normal)).toContain('немає даних');
    expect(text(normal)).not.toContain('verify_facts');
  });

  it('per-shipment state stays last (cache prefix first)', () => {
    expect(Array.isArray(shipment) && shipment[0]?.cache_control).toBeTruthy();
    expect(Array.isArray(shipment) && shipment[1]?.text).toContain('ПОТОЧНЕ ПОСТАЧАННЯ');
  });
});

describe('system prompt size (spec 010: ≤ 60 % of before)', () => {
  it.each([
    ['shipment', shipment],
    ['consolidated', consolidated],
    ['normal', normal],
  ] as const)('%s', (name, built) => {
    expect(bytes(built)).toBeLessThanOrEqual(BEFORE[name] * 0.6);
  });
});
