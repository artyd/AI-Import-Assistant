import { describe, it, expect } from 'vitest';
import { buildFacts } from '../facts.js';

import { base } from './fixture.js';

describe('report facts — Метопрен', () => {
  const f = buildFacts(base);

  it('legs, markup and customs money', () => {
    expect(f.money.outbound).toMatchObject({ value: 8750, currency: 'USD', incoterm: 'CPT' });
    expect(f.money.inbound).toMatchObject({ value: 13125 });
    expect(f.money.markupPct).toBe(-33);
    expect(f.money).toMatchObject({ customsValueUah: 391051.5, dutyUah: 25418.35, vatUah: 83293.97, rate: 44.6916, dutyRatePct: 6.5 });
    expect(f.classification.vatPct).toBe(20);
  });

  it('cost per kg = customs value + duty + broker (freight billed to the intermediary is excluded), excl. VAT', () => {
    expect(f.money.servicesUah).toEqual([{ kind: 'broker', amountUah: 6163 }]);
    expect(f.money.costPerKgUah).toBe(Math.round((391051.5 + 25418.35 + 6163) / 25));
    expect(f.money.freightInPrice).toBe(true);
  });

  it('durations and cleared status', () => {
    expect(f.durations).toEqual({ contractToDeclaration: 58, shipmentToDeclaration: 17 });
    expect(f.cleared).toMatchObject({ date: '31.07.2026' });
  });

  it('route Mumbai → Frankfurt → Kyiv → Bila Tserkva with modes', () => {
    expect(f.route.stops.map((s) => s.name)).toEqual(['Mumbai', 'Frankfurt', 'Kyiv', 'Bila Tserkva']);
    expect(f.route.legs.map((l) => l.mode)).toEqual(['air', 'road', 'road']);
  });

  it('timeline is chronological and merges same-day events', () => {
    expect(f.timeline.map((t) => t.date)).toEqual(['03.06', '22.06', '09.07', '14.07', '23.07', '31.07', '01.08']);
    expect(f.timeline.find((t) => t.date === '31.07')?.label).toBe('МД');
  });

  it('product and classification (МД as source when qdpro is off)', () => {
    expect(f.product).toMatchObject({ name: 'S-METHOPRENE', cas: '65733-16-6', quantity: 25, batch: 'SMP/06/012/2026', manufactured: '06.2026', expiry: '05.2029' });
    expect(f.classification).toMatchObject({ hsCode: '2918999090', hsSource: 'МД' });
  });

  it('top risks: errors first, no "documents" notes or registry info', () => {
    expect(f.risksTop.map((r) => r.title)).toEqual([
      'Розбіжність: націнка посередника',
      'Розбіжність: вага нетто',
      'Розбіжність: вага брутто',
    ]);
    expect(f.counts).toEqual({ errors: 2, warnings: 2 });
  });
});
