import { describe, expect, it } from 'vitest';
import { freeTimeOf, parseLineDays } from '../freetime.js';

const D = { days: 7, byLine: parseLineDays('MSC:10, maersk = 5') };
const base = {
  mode: 'sea' as const,
  cargoType: 'fcl' as const,
  status: 'in_transit' as const,
  statusDate: null,
  arrival: { date: '2026-10-20', guessed: false },
  freeDays: null,
  line: '',
  carrier: 'cosco',
};

describe('freeTimeOf', () => {
  it('counts from the planned arrival with the default days', () => {
    expect(freeTimeOf(base, D)).toEqual({ start: '2026-10-20', end: '2026-10-27', days: 7, source: 'default', fromActual: false });
  });
  it('counts from the actual arrival once it arrived', () => {
    const r = freeTimeOf({ ...base, status: 'arrived', statusDate: { date: '2026-10-22', guessed: false } }, D)!;
    expect(r).toMatchObject({ start: '2026-10-22', end: '2026-10-29', fromActual: true });
  });
  it('uses the line default, and the sheet column over everything', () => {
    expect(freeTimeOf({ ...base, line: 'MSC' }, D)).toMatchObject({ days: 10, source: 'line', end: '2026-10-30' });
    expect(freeTimeOf({ ...base, carrier: 'maersk' }, D)).toMatchObject({ days: 5, source: 'line' });
    expect(freeTimeOf({ ...base, line: 'MSC', freeDays: 14 }, D)).toMatchObject({ days: 14, source: 'sheet' });
  });
  it('does not apply to air / parcels or cleared cargo', () => {
    expect(freeTimeOf({ ...base, mode: 'air', cargoType: 'air' }, D)).toBeNull();
    expect(freeTimeOf({ ...base, status: 'customs' }, D)).toBeNull();
    expect(freeTimeOf({ ...base, arrival: null }, D)).toBeNull();
  });
});

describe('parseLineDays', () => {
  it('reads "LINE:days" pairs', () => {
    expect(parseLineDays('MSC:10, MAERSK=7; cma : 14')).toEqual({ MSC: 10, MAERSK: 7, CMA: 14 });
    expect(parseLineDays('')).toEqual({});
  });
});
