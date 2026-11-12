import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../tools/retrieval.js', () => ({ findFile: vi.fn() }));
vi.mock('../../ingest/markdown/store.js', () => ({ loadFileMarkdown: vi.fn() }));

import { runVerifyFacts, type VerifyDeps } from '../tools/verify.js';
import type { CorpusDoc } from '../answerCheck.js';

const invoice: CorpusDoc = {
  file: 'invoice.pdf',
  pages: [
    { page: 1, text: 'Invoice No. INV-2024-001 dated 12.03.2025' },
    { page: 2, text: 'Total: 12 345,67 USD. Net weight 25 000 kg. HS 2915 90 00 00' },
  ],
};
const packing: CorpusDoc = { file: 'packing.pdf', pages: [{ page: 1, text: 'Gross 25 500 kg, container MSKU1234567' }] };
const fields: CorpusDoc = { file: 'invoice.pdf (поля)', pages: [{ page: null, text: 'invoice_number: INV-2024-001' }] };

const deps = (): VerifyDeps => ({
  loadNamed: async (_ws, name) => (name.toLowerCase().includes('invoice') ? invoice : name.toLowerCase().includes('packing') ? packing : null),
  loadAll: async () => [invoice, packing, fields],
});
const ctx = { workspaceId: 'ws-1' };

describe('verify_facts handler', () => {
  it('finds a value in the named file with its page', async () => {
    const out = await runVerifyFacts({ facts: [{ value: '12345.67 USD', file: 'invoice.pdf' }] }, ctx, deps());
    expect(out.result).toContain('invoice.pdf, стор. 2');
    expect(out.summary).toMatch(/1 з 1/);
    expect(out.citations).toEqual([{ file: 'invoice.pdf', page: 2 }]);
  });

  it('falls back to all files when the named file lacks the value, and says so', async () => {
    const out = await runVerifyFacts({ facts: [{ value: 'MSKU1234567', file: 'invoice.pdf' }] }, ctx, deps());
    expect(out.result).toContain('packing.pdf, стор. 1');
    expect(out.result).toMatch(/не в invoice\.pdf/);
  });

  it('reports not_found and warns not to state it as a fact', async () => {
    const out = await runVerifyFacts({ facts: [{ value: '99 999 kg' }] }, ctx, deps());
    expect(out.result).toMatch(/НЕ ЗНАЙДЕНО/);
    expect(out.summary).toMatch(/не знайдено: 1/);
  });

  it('honours the page filter on the named file', async () => {
    const wrongPage = await runVerifyFacts({ facts: [{ value: 'INV-2024-001', file: 'invoice.pdf', page: 2 }] }, ctx, deps());
    expect(wrongPage.result).toContain('стор. 1'); // not on page 2, found elsewhere
    expect(wrongPage.result).toMatch(/не на стор\. 2/);
  });

  it('finds a value only present in extracted fields', async () => {
    const out = await runVerifyFacts({ facts: [{ value: 'inv-2024-001' }] }, ctx, deps());
    expect(out.result).toContain('invoice.pdf (поля)');
  });

  it('collects every input problem in one text instead of throwing', async () => {
    const out = await runVerifyFacts({ facts: [{ value: '' }, { value: 'x', page: 0 }] }, ctx, deps());
    expect(out.result).toMatch(/facts\.0\.value/);
    expect(out.result).toMatch(/facts\.1\.page/);
  });

  it('rejects more than 40 facts with a repairable message', async () => {
    const facts = Array.from({ length: 41 }, (_, i) => ({ value: String(1000 + i) }));
    const out = await runVerifyFacts({ facts }, ctx, deps());
    expect(out.result).toMatch(/40/);
  });

  it('needs a shipment scope', async () => {
    await expect(runVerifyFacts({ facts: [{ value: '1' }] }, {}, deps())).rejects.toThrow();
  });
});
