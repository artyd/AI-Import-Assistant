import { describe, expect, it, vi } from 'vitest';

// extractFields imports the Anthropic client (config) — stub it for a pure test.
vi.mock('../../../lib/anthropic/client.js', () => ({ anthropic: {}, MODEL: 'test' }));
vi.mock('../../../lib/anthropic/limiter.js', () => ({ runWithAnthropicLimit: (f: () => unknown) => f() }));
vi.mock('../../../lib/config.js', () => ({ config: {} }));

const { normalizeExtraction, toBool } = await import('../extractFields.js');
const { mergeExtractions } = await import('../mergeExtractions.js');

// Fictional values only (the repo is public).
const IBAN_A = 'DE12 5001 0517 0000 0620 11';
const IBAN_B = 'DE12 5001 0517 0000 0820 11';

describe('integrity fields — normaliser', () => {
  it('reads bank accounts, dangerous goods, signature / stamp and blank fields', () => {
    const f = normalizeExtraction({
      doc_type: 'invoice',
      bank_accounts: [
        { iban: IBAN_A, swift: 'TESTDEFF', bank_name: 'Testbank AG', beneficiary: 'Fictiva Chemicals GmbH' },
        { iban: '  ', swift: null, bank_name: '', beneficiary: null }, // empty block → dropped
        'junk',
      ],
      dangerous_goods: { is_dangerous: true, un_number: 'UN 1940', adr_class: '8', packing_group: 'III' },
      signed: false,
      stamped: 'так',
      empty_fields: ['Consignee', 'Batch No.', 'consignee', '', 7],
    });
    expect(f.bank_accounts).toEqual([
      { iban: IBAN_A, swift: 'TESTDEFF', bank_name: 'Testbank AG', beneficiary: 'Fictiva Chemicals GmbH' },
    ]);
    expect(f.dangerous_goods).toEqual({ is_dangerous: true, un_number: 'UN 1940', adr_class: '8', packing_group: 'III' });
    expect(f.signed).toBe(false);
    expect(f.stamped).toBe(true);
    expect(f.empty_fields).toEqual(['Consignee', 'Batch No.', '7']);
  });

  it('missing fields read as null / []', () => {
    const f = normalizeExtraction({ doc_type: 'invoice' });
    expect(f.bank_accounts).toEqual([]);
    expect(f.dangerous_goods).toBeNull();
    expect(f.signed).toBeNull();
    expect(f.stamped).toBeNull();
    expect(f.empty_fields).toEqual([]);
    // a dangerous_goods object that states nothing is no statement
    expect(normalizeExtraction({ dangerous_goods: {} }).dangerous_goods).toBeNull();
    expect(normalizeExtraction({ dangerous_goods: { is_dangerous: false } }).dangerous_goods?.is_dangerous).toBe(false);
  });

  it('toBool', () => {
    expect(toBool(true)).toBe(true);
    expect(toBool('false')).toBe(false);
    expect(toBool('ні')).toBe(false);
    expect(toBool('maybe')).toBeNull();
    expect(toBool(undefined)).toBeNull();
  });
});

describe('integrity fields — multi-part merge', () => {
  it('unions bank blocks and blank fields; a signature on any part counts', () => {
    const p1 = normalizeExtraction({
      doc_type: 'invoice',
      bank_accounts: [{ iban: IBAN_A }],
      signed: false,
      empty_fields: ['Batch No.'],
    });
    const p2 = normalizeExtraction({
      doc_type: 'invoice',
      bank_accounts: [{ iban: IBAN_A.replace(/\s/g, '') }, { iban: IBAN_B }],
      signed: true,
      dangerous_goods: { un_number: '1940', adr_class: '8' },
      empty_fields: ['batch no.', 'Consignee'],
    });
    const m = mergeExtractions([p1, p2])!;
    expect(m.bank_accounts?.map((b) => b.iban)).toEqual([IBAN_A, IBAN_B]);
    expect(m.signed).toBe(true);
    expect(m.stamped).toBeNull();
    expect(m.dangerous_goods?.un_number).toBe('1940');
    expect(m.empty_fields).toEqual(['Batch No.', 'Consignee']);
  });
});
