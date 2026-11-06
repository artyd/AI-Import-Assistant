import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = { LOGIST_MCP_URL: '' };
const sql: string[] = [];
let extractions: { fields: Record<string, unknown> | null }[] = [];
let fresh: { hs_code: string }[] = [];
const upserts: unknown[][] = [];

vi.mock('../../lib/config.js', () => ({ config: cfg }));
vi.mock('../../db/pool.js', () => ({
  query: vi.fn(async (text: string, params: unknown[]) => {
    sql.push(text);
    if (text.includes('FROM files f JOIN document_extractions')) return { rows: extractions };
    if (text.includes('fetched_at > now()')) return { rows: fresh };
    if (text.startsWith('INSERT INTO hs_requirements')) upserts.push(params);
    return { rows: [] };
  }),
}));
const lookup = vi.fn();
vi.mock('../logist/index.js', () => ({
  logistEnabled: () => cfg.LOGIST_MCP_URL.trim().length > 0,
  uktzedLookup: (code: string) => lookup(code),
}));

const { refreshShipmentHsRequirements } = await import('../hsRequirementsCache.js');

beforeEach(() => {
  cfg.LOGIST_MCP_URL = '';
  sql.length = 0;
  upserts.length = 0;
  extractions = [];
  fresh = [];
  lookup.mockReset();
});

describe('refreshShipmentHsRequirements', () => {
  it('does nothing when the reference service is off (LOGIST_MCP_URL empty)', async () => {
    extractions = [{ fields: { hs_code: '2922410000' } }];
    await refreshShipmentHsRequirements('ws1');
    expect(sql).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('fetches a code missing from the cache and stores its import requirements', async () => {
    cfg.LOGIST_MCP_URL = 'http://logist:8015';
    extractions = [{ fields: { hs_code: '2922 41 00 00', line_items: [{ hs_code: '3003000000' }] } }];
    fresh = [{ hs_code: '3003000000' }];
    lookup.mockResolvedValue({
      code: '2922410000',
      source: 'https://example.test/goodinfo/2922410000',
      tabs: [
        { label: 'ІМПОРТ', text: 'Ветеринарно-санітарний контроль\nКод документу 5514' },
        { label: 'ЕКСПОРТ', text: 'Ліцензування експорту' },
      ],
    });
    await refreshShipmentHsRequirements('ws1');
    expect(lookup.mock.calls).toEqual([['2922410000']]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.[0]).toBe('2922410000');
    expect(JSON.parse(String(upserts[0]?.[1]))).toEqual([{ key: 'veterinary_certificate', evidence: 'Ветеринарно-санітарний контроль' }]);
  });

  it('a failing qdpro is swallowed and nothing is cached', async () => {
    cfg.LOGIST_MCP_URL = 'http://logist:8015';
    extractions = [{ fields: { hs_code: '1111111111' } }];
    lookup.mockRejectedValue(new Error('down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(refreshShipmentHsRequirements('ws1')).resolves.toBeUndefined();
    expect(upserts).toEqual([]);
    err.mockRestore();
  });

  it('a page without an import regime is not cached as "no requirements"', async () => {
    cfg.LOGIST_MCP_URL = 'http://logist:8015';
    extractions = [{ fields: { hs_code: '2222222222' } }];
    lookup.mockResolvedValue({ code: '2222222222', source: 's', tabs: [], common: 'Ветеринарно-санітарний контроль' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await refreshShipmentHsRequirements('ws1');
    expect(upserts).toEqual([]);
    err.mockRestore();
  });

  it('a slow qdpro does not hold the verdicts past the wait', async () => {
    cfg.LOGIST_MCP_URL = 'http://logist:8015';
    extractions = [{ fields: { hs_code: '3333333333' } }];
    lookup.mockImplementation(() => new Promise(() => undefined));
    const t0 = Date.now();
    await refreshShipmentHsRequirements('ws1', 50);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
