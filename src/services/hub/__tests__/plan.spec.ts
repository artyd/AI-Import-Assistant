import { describe, expect, it } from 'vitest';
import { computePlan, estimateLegDays, legGeometry, type LegInput, type TrackFact } from '../plan.js';

const NGB: [number, number] = [29.93, 121.85];
const ODS: [number, number] = [46.49, 30.75];
const KYIV: [number, number] = [50.45, 30.52];

function leg(o: Partial<LegInput> & Pick<LegInput, 'id' | 'seq' | 'mode'>): LegInput {
  return {
    from: { code: '', name: '', pos: null },
    to: { code: '', name: '', pos: null },
    carrier: '',
    via: '',
    trackedId: null,
    plannedDeparture: null,
    plannedArrival: null,
    costAmount: null,
    costCurrency: 'USD',
    freeDays: null,
    demurragePerDay: null,
    notes: '',
    ...o,
  };
}

const sea = (o: Partial<LegInput> = {}) =>
  leg({
    id: 'sea',
    seq: 0,
    mode: 'sea',
    from: { code: 'CNNGB', name: 'Нінбо', pos: NGB },
    to: { code: 'UAODS', name: 'Одеса', pos: ODS },
    plannedDeparture: '2026-09-01T00:00:00Z',
    plannedArrival: '2026-10-05T00:00:00Z',
    costAmount: 3200,
    freeDays: 3,
    demurragePerDay: 100,
    ...o,
  });
const road = (o: Partial<LegInput> = {}) =>
  leg({
    id: 'road',
    seq: 1,
    mode: 'road',
    from: { code: 'UAODS', name: 'Одеса', pos: ODS },
    to: { code: 'UAIEV', name: 'Київ', pos: KYIV },
    plannedDeparture: '2026-10-07T00:00:00Z',
    plannedArrival: '2026-10-08T00:00:00Z',
    costAmount: 700,
    ...o,
  });

describe('route plan maths', () => {
  it('builds geometry per mode and estimates durations', () => {
    expect(legGeometry(sea()).length).toBeGreaterThan(5);
    expect(legGeometry(road())).toHaveLength(2);
    expect(estimateLegDays('road', legGeometry(road()))).toBeGreaterThan(0.5);
    expect(estimateLegDays('road', legGeometry(road()))).toBeLessThan(3);
    expect(estimateLegDays('sea', legGeometry(sea()))).toBeGreaterThan(20);
  });

  it('sums costs and has no delay with nothing tracked', () => {
    const p = computePlan([sea(), road()], new Map(), Date.parse('2026-09-10T00:00:00Z'));
    expect(p.costs).toEqual({ USD: 3900 });
    expect(p.delayDays).toBe(0);
    expect(p.health).toBe('draft');
    expect(p.legs[0]!.freeTime).toMatchObject({ freeDays: 3, overDays: 0, demurrageCost: 0 });
  });

  it('cascades a sea delay into the next leg and prices demurrage', () => {
    const facts = new Map<string, TrackFact>([
      // ETA slipped 6 days past the planned arrival.
      ['T1', { status: 'in_transit', departedAt: '2026-09-01T00:00:00Z', arrivedAt: null, eta: '2026-10-11T00:00:00Z', path: [] }],
    ]);
    const p = computePlan([sea({ trackedId: 'T1' }), road()], facts, Date.parse('2026-10-01T00:00:00Z'));
    expect(p.legs[0]!.delayDays).toBe(6);
    // Road can't leave before the box arrives → projected departure = sea ETA.
    expect(p.legs[1]!.projectedDeparture).toBe('2026-10-11T00:00:00.000Z');
    expect(p.delayDays).toBeGreaterThanOrEqual(4);
    expect(p.health).toBe('at_risk');
    // Picked up the day it arrives → within free time.
    expect(p.legs[0]!.freeTime!.overDays).toBe(0);
  });

  it('charges demurrage when pickup is after free time', () => {
    const facts = new Map<string, TrackFact>([
      ['T1', { status: 'at_port', departedAt: '2026-09-01T00:00:00Z', arrivedAt: '2026-10-05T00:00:00Z', eta: null, path: [] }],
    ]);
    const p = computePlan(
      [sea({ trackedId: 'T1' }), road({ plannedDeparture: '2026-10-12T00:00:00Z', plannedArrival: '2026-10-13T00:00:00Z' })],
      facts,
      Date.parse('2026-10-06T00:00:00Z'),
    );
    const ft = p.legs[0]!.freeTime!;
    expect(ft.endsAt).toBe('2026-10-08T00:00:00.000Z');
    expect(ft.overDays).toBe(4);
    expect(ft.demurrageCost).toBe(400);
    expect(ft.daysLeft).toBe(2);
    expect(p.demurrage).toEqual({ USD: 400 });
  });

  it('fills missing dates from estimates chained after the previous leg', () => {
    const p = computePlan([sea(), road({ plannedDeparture: null, plannedArrival: null })], new Map());
    expect(p.legs[1]!.datesEstimated).toBe(true);
    expect(p.legs[1]!.plannedDeparture).toBe('2026-10-05T00:00:00.000Z');
    expect(new Date(p.legs[1]!.plannedArrival!).getTime()).toBeGreaterThan(Date.parse('2026-10-05T00:00:00Z'));
  });
});

describe('actual path from events', () => {
  it('drops duplicates and follows sea lanes between port calls', async () => {
    const { factPath } = await import('../routePlans.js');
    const raw: [number, number][] = [[29.93, 121.85], [29.93, 121.85], [31.26, 32.31], [46.49, 30.75]];
    const sea = factPath(raw, true);
    expect(sea.length).toBeGreaterThan(raw.length);
    expect(factPath(raw, false)).toHaveLength(3);
  });
});
