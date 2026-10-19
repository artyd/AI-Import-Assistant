import { describe, expect, it } from 'vitest';
import { planManualUpdate, type ManualItem } from '../manualPlan.js';

const NOW = '2026-10-19T12:00:00.000Z';
const item = (over: Partial<ManualItem> = {}): ManualItem => ({
  status: 'in_transit', status_text: '', origin: 'Mumbai', destination: 'Odesa',
  vessel_name: '', vessel_imo: '', departed_at: '2026-10-01T12:00:00Z',
  eta: '2026-10-25T12:00:00Z', arrived_at: null,
  ...over,
});

describe('hand-kept track plan', () => {
  it('only the fields present change', () => {
    const p = planManualUpdate(item(), { statusText: 'на рейді' }, 'hand', NOW);
    expect(p.status).toBe('in_transit');
    expect(p.origin).toBe('Mumbai');
    expect(p.originChanged).toBe(false);
    expect(p.statusText).toBe('на рейді');
    expect(p.notifications).toEqual([]);
  });

  it('delivered without an arrival time → arrived now', () => {
    expect(planManualUpdate(item(), { status: 'delivered' }, 'sheet', NOW).arrivedAt).toBe(NOW);
  });

  it('moving into in-transit without a departure anchors it now — for the sheet too', () => {
    const p = planManualUpdate(item({ status: 'info', departed_at: null }), { status: 'in_transit', departedAt: null }, 'sheet', NOW);
    expect(p.departedAt).toBe(NOW);
  });

  it('an important status change notifies teammates, whoever entered it', () => {
    const hand = planManualUpdate(item(), { status: 'at_port' }, 'hand', NOW);
    const sheet = planManualUpdate(item(), { status: 'at_port' }, 'sheet', NOW);
    expect(hand.notifications.map((n) => n.kind)).toEqual(['at_port']);
    expect(sheet.notifications.map((n) => n.kind)).toEqual(['at_port']);
    expect(sheet.notifications[0]!.text).toContain('(таблиця)');
    expect(hand.notifications[0]!.text).toContain('(внесено вручну)');
  });

  it('never notifies on the first status after "pending", nor on an unimportant one', () => {
    expect(planManualUpdate(item({ status: 'pending' }), { status: 'at_port' }, 'hand', NOW).notifications).toEqual([]);
    expect(planManualUpdate(item(), { status: 'info' }, 'hand', NOW).notifications).toEqual([]);
  });

  it('an ETA shift of a day or more notifies for hub edits; the sheet announces its own plan change', () => {
    const m = { eta: '2026-10-28T12:00:00Z' };
    expect(planManualUpdate(item(), m, 'hand', NOW).notifications.map((n) => n.kind)).toEqual(['eta']);
    expect(planManualUpdate(item(), m, 'sheet', NOW).notifications).toEqual([]);
  });

  it('a new vessel re-arms AIS', () => {
    expect(planManualUpdate(item(), { vesselName: 'MSC ANNA' }, 'hand', NOW).vesselChanged).toBe(true);
  });
});
