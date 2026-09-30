import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ query: vi.fn() }));
vi.mock('../../config.js', () => ({ config: {} }));

describe('normalizeUnit', () => {
  it('maps aliases to one canonical unit', async () => {
    const { normalizeUnit } = await import('../reconcile.js');
    expect(normalizeUnit('KGS')).toBe('kg');
    expect(normalizeUnit('кг.')).toBe('kg');
    expect(normalizeUnit('шт')).toBe(normalizeUnit('pcs'));
    expect(normalizeUnit('drums')).toBe('drums');
    expect(normalizeUnit('')).toBeNull();
    expect(normalizeUnit(null)).toBeNull();
  });
});
