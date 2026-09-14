import { describe, it, expect, vi } from 'vitest';

// Mock the server-side Anthropic client so the AI step fails fast (no network,
// no config load). runAnalysis must degrade gracefully to a deterministic-only
// result rather than crash.
vi.mock('../../../anthropic/client.js', () => ({
  anthropic: {
    messages: { create: vi.fn().mockRejectedValue(new Error('no network in test')) },
  },
  MODEL: 'claude-test',
}));

import { runAnalysis } from '../run.js';

describe('runAnalysis (consolidated, B-2)', () => {
  it('computes deterministic rows/totals from a CSV and degrades the AI step', async () => {
    const csv = [
      'Номенклатура,Вага кг,Ціна,УКТЗЕД',
      'Гіалуронова кислота,25,210,3913900090',
      'DL-Метіонін кормовий,1000,2.4,',
    ].join('\n');

    const res = await runAnalysis({ kind: 'text', text: csv });

    expect(res.rows.length).toBe(2);
    expect(res.totals.count).toBe(2);
    // CIF incoterm default → customs value = goods (25*210 + 1000*2.4).
    expect(res.totals.cif).toBeCloseTo(7650, 2);
    // AI unavailable → degraded, deterministic-only, every row flagged for review.
    expect(res.aiDegraded).toBe(true);
    expect(res.rows.every((r) => r.needsReview)).toBe(true);
    expect(res.rows.every((r) => r.risk === null)).toBe(true);
    expect(res.id).toBeNull();
    expect(res.source).toBe('Вставлена таблиця');
  });
});
