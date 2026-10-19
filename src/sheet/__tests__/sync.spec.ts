import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../../lib/config.js', () => ({ config: { SHEET_FREE_DAYS: 7, SHEET_FREE_DAYS_BY_LINE: '' } }));

const { rowNotifications, sheetManualInput } = await import('../sync.js');
type Row = Parameters<typeof rowNotifications>[0];

// Synthetic rows only — never real sheet data (ADR-0009).
const row = (over: Partial<Row> = {}): Row =>
  ({
    rowIndex: 12, key: 'k', product: 'Тест-субстанція', destination: 'Одеса', origin: 'Mumbai',
    logist: 'Люда', comment: '', extra: '', active: true, status: 'in_transit',
    mode: 'sea', cargoType: 'fcl', line: '', carrier: '', freeDays: null,
    departure: { date: '2026-10-01' }, arrival: { date: '2026-10-25' }, statusDate: null,
    ...over,
  }) as unknown as Row;

const TODAY = '2026-10-19';

describe('sheet row notifications', () => {
  it('plan change → one message to the logist, deduped by the new date', () => {
    const n = rowNotifications(row(), '2026-10-22', true, 'r1', TODAY);
    expect(n.map((x) => x.key)).toEqual(['sheet:r1:plan:2026-10-25']);
    expect(n[0]!.text).toContain('22.10.2026 → 25.10.2026');
  });

  it('no plan-change message for a row seen for the first time or inactive', () => {
    expect(rowNotifications(row(), null, false, 'r1', TODAY)).toEqual([]);
    expect(rowNotifications(row({ active: false }), '2026-10-22', true, 'r1', TODAY)).toEqual([]);
  });

  it('arrival tomorrow / today', () => {
    expect(rowNotifications(row({ arrival: { date: '2026-10-20' } } as Partial<Row>), null, false, 'r1', TODAY).map((x) => x.key))
      .toEqual(['sheet:r1:d1:2026-10-20']);
    expect(rowNotifications(row({ arrival: { date: TODAY } } as Partial<Row>), null, false, 'r1', TODAY).map((x) => x.key))
      .toContain(`sheet:r1:d0:${TODAY}`);
  });
});

describe('sheet → hand-kept track input', () => {
  it('customs or delivered rows close the track as delivered on the status date', () => {
    const m = sheetManualInput(row({ status: 'customs', statusDate: { date: '2026-10-18' } } as Partial<Row>));
    expect(m.status).toBe('delivered');
    expect(m.arrivedAt).toBe('2026-10-18T12:00:00Z');
  });

  it('an in-transit row carries the plan dates and keeps the stored arrival', () => {
    const m = sheetManualInput(row());
    expect(m).toMatchObject({ status: 'in_transit', departedAt: '2026-10-01T12:00:00Z', eta: '2026-10-25T12:00:00Z' });
    expect(m.arrivedAt).toBeUndefined();
  });
});
