import { describe, expect, it } from 'vitest';
import { interpolateAlong, stableProgress, type LatLng } from '../geo.js';

describe('stableProgress', () => {
  it('is deterministic for the same seed', () => {
    expect(stableProgress('2026-0815')).toBe(stableProgress('2026-0815'));
  });

  it('returns a fraction in [0, 1)', () => {
    for (const seed of ['a', '2026-0001', 'ШТУРМАН', '', 'x'.repeat(50)]) {
      const p = stableProgress(seed);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('varies across different seeds', () => {
    const values = new Set(['0001', '0002', '0003', '0004'].map(stableProgress));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe('interpolateAlong', () => {
  const line: LatLng[] = [
    [0, 0],
    [0, 10],
    [10, 10],
  ];

  it('returns the first vertex at t=0 and last at t=1', () => {
    expect(interpolateAlong(line, 0)).toEqual([0, 0]);
    expect(interpolateAlong(line, 1)).toEqual([10, 10]);
  });

  it('clamps out-of-range t', () => {
    expect(interpolateAlong(line, -5)).toEqual([0, 0]);
    expect(interpolateAlong(line, 5)).toEqual([10, 10]);
  });

  it('lands at the shared vertex at the midpoint of an equal-length two-segment line', () => {
    expect(interpolateAlong(line, 0.5)).toEqual([0, 10]);
  });

  it('handles a single-vertex line', () => {
    expect(interpolateAlong([[3, 4]], 0.7)).toEqual([3, 4]);
  });

  it('throws on empty waypoints', () => {
    expect(() => interpolateAlong([], 0.5)).toThrow();
  });
});
