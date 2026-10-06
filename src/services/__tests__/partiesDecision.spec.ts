import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ query: vi.fn() }));
vi.mock('../../config.js', () => ({ config: {} }));

const b = (name: string, sources: string[], country: string | null = null) => ({
  name,
  country,
  sources: new Set(sources),
});

describe('decideParties — 2 vs 3 sides from the commercial legs', () => {
  it('trader selling a factory\'s goods directly is BILATERAL (hydrocortisone case)', async () => {
    const { decideParties } = await import('../partyExtraction.js');
    const r = decideParties(
      b('Tianjin Tianyao Pharmaceuticals Co., Ltd.', ['01102026PJH.docx'], 'Китай'),
      b('Jinyao Pharmaceuticals (Singapore) PTE. LTD.', ['01102026PJH.docx']),
      b('TEKHINFORM PLUS LLC', ['01102026PJH.docx']),
      1,
      [{ seller: 'Jinyao Pharmaceuticals (Singapore) PTE. LTD.', buyer: 'TEKHINFORM PLUS LLC', source: '01102026PJH.docx' }],
    );
    expect(r.contract_type).toBe('bilateral');
    expect(r.suggestions.find((s) => s.role === 'sender')?.company_name).toMatch(/Jinyao/);
    expect(r.suggestions.find((s) => s.role === 'intermediary')).toBeUndefined();
    expect(r.suggestions.find((s) => s.role === 'recipient')?.company_name).toBe('TEKHINFORM PLUS LLC');
    expect(r.manufacturer?.name).toMatch(/Tianyao/);
    expect(r.contract_type_reason).toMatch(/лише виробник/);
  });

  it('a resale chain is TRILATERAL (Сборник 18: Rivita → Prime Force → Novalait)', async () => {
    const { decideParties } = await import('../partyExtraction.js');
    const r = decideParties(
      b('HS Nutra Co., Ltd.', ['coa.pdf']),
      b('PRIME FORCE UK BUSINESS LIMITED', ['JLIN251215PF.pdf']),
      b('NOVALAIT LLC', ['JLIN251215PF.pdf']),
      3,
      [
        { seller: 'ZHEJIANG RIVITA BIOTECH CO., LTD', buyer: 'PRIME FORCE UK BUSINESS LIMITED', source: '15122025PZB.pdf' },
        { seller: 'PRIME FORCE UK BUSINESS LIMITED', buyer: '"NOVALAIT" LLC', source: 'JLIN251215PF.pdf' },
      ],
    );
    expect(r.contract_type).toBe('trilateral');
    expect(r.suggestions.find((s) => s.role === 'sender')?.company_name).toMatch(/RIVITA/);
    expect(r.suggestions.find((s) => s.role === 'intermediary')?.company_name).toMatch(/PRIME FORCE/);
    expect(r.suggestions.find((s) => s.role === 'recipient')?.company_name).toMatch(/NOVALAIT/);
  });

  it('the factory selling directly is BILATERAL', async () => {
    const { decideParties } = await import('../partyExtraction.js');
    const r = decideParties(b('NGL Fine-Chem', ['inv.pdf']), b('NGL Fine-Chem Ltd', ['inv.pdf']), b('AGroup95', ['inv.pdf']), 1, [
      { seller: 'NGL Fine-Chem Ltd', buyer: 'AGroup95', source: 'inv.pdf' },
    ]);
    expect(r.contract_type).toBe('bilateral');
    expect(r.contract_type_confidence).toBe(1);
  });

  it('without a seller the type stays undecided', async () => {
    const { decideParties } = await import('../partyExtraction.js');
    const r = decideParties(b('Maker', ['coa.pdf']), null, null, 1, []);
    expect(r.contract_type).toBeNull();
    expect(r.suggestions[0]).toMatchObject({ role: 'sender', uncertain_role: true });
  });
});
