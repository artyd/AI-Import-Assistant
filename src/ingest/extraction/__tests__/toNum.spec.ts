import { describe, expect, it, vi } from 'vitest';

// extractFields imports the Anthropic client (config) — stub it for a pure test.
vi.mock('../../../lib/anthropic/client.js', () => ({ anthropic: {}, MODEL: 'test' }));
vi.mock('../../../lib/anthropic/limiter.js', () => ({ runWithAnthropicLimit: (f: () => unknown) => f() }));
vi.mock('../../../lib/config.js', () => ({ config: {} }));

describe('toNum', () => {
  it('parses thousands and decimal separators', async () => {
    const { toNum } = await import('../extractFields.js');
    expect(toNum('1,234,567')).toBe(1234567);
    expect(toNum('1.234.567')).toBe(1234567);
    expect(toNum('1,234.50')).toBe(1234.5);
    expect(toNum('1.234,50')).toBe(1234.5);
    expect(toNum('12 500,00 USD')).toBe(12500);
    expect(toNum('12,5')).toBe(12.5);
    expect(toNum(42)).toBe(42);
    expect(toNum('')).toBeNull();
  });
});
