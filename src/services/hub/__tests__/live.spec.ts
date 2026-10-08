import { describe, expect, it } from 'vitest';
import { legPath, type LatLng } from '../geo.js';
import { effectiveDates } from '../live.js';

const NINGBO: LatLng = [29.93, 121.85];
const ODESA: LatLng = [46.49, 30.75];
const path = legPath('sea', NINGBO, ODESA);
const DAY = 86_400_000;
const base = { status: 'in_transit', created_at: '2026-10-01T00:00:00.000Z' };

describe('effectiveDates', () => {
  it('keeps both dates when the logist gave them', () => {
    const r = effectiveDates({ ...base, departed_at: '2026-09-20T00:00:00.000Z', eta: '2026-10-25T00:00:00.000Z' }, 'sea', path);
    expect(r).toEqual({ departedAt: '2026-09-20T00:00:00.000Z', eta: '2026-10-25T00:00:00.000Z', etaEstimated: false });
  });

  it('derives the ETA from departure + typical sea transit, flagged as estimated', () => {
    const r = effectiveDates({ ...base, departed_at: '2026-09-20T00:00:00.000Z', eta: null }, 'sea', path);
    expect(r.etaEstimated).toBe(true);
    const days = (new Date(r.eta!).getTime() - new Date('2026-09-20T00:00:00.000Z').getTime()) / DAY;
    expect(days).toBeGreaterThan(20); // Ningbo → Odesa is weeks, not days
    expect(days).toBeLessThan(70);
  });

  it('derives the departure back from a given ETA (ETA itself stays exact)', () => {
    const r = effectiveDates({ ...base, departed_at: null, eta: '2026-11-10T00:00:00.000Z' }, 'sea', path);
    expect(r.eta).toBe('2026-11-10T00:00:00.000Z');
    expect(r.etaEstimated).toBe(false);
    expect(new Date(r.departedAt!).getTime()).toBeLessThan(new Date('2026-11-10T00:00:00.000Z').getTime());
  });

  it('a later ETA from the logist moves everything with it', () => {
    const a = effectiveDates({ ...base, departed_at: null, eta: '2026-11-10T00:00:00.000Z' }, 'sea', path);
    const b = effectiveDates({ ...base, departed_at: null, eta: '2026-11-15T00:00:00.000Z' }, 'sea', path);
    expect(new Date(b.departedAt!).getTime() - new Date(a.departedAt!).getTime()).toBe(5 * DAY);
  });

  it('in transit with no dates at all: counts from when the item was added', () => {
    const r = effectiveDates({ ...base, departed_at: null, eta: null }, 'sea', path);
    expect(r.departedAt).toBe(base.created_at);
    expect(r.etaEstimated).toBe(true);
  });

  it('does not invent dates without a route or for a booked item', () => {
    expect(effectiveDates({ ...base, departed_at: null, eta: null }, 'sea', [])).toMatchObject({ eta: null });
    expect(effectiveDates({ ...base, status: 'info', departed_at: null, eta: null }, 'sea', path)).toMatchObject({ eta: null });
  });
});
