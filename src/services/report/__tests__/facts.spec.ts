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
    expect(f.classification).toMatchObject({ hsCode: '2918 99 90 90', hsSource: 'МД' });
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

import { buildRoute, compactDetail } from '../facts.js';
describe('report — live-data shapes (Метопрен prod)', () => {
  it('AWB + HAWB copy "Mumbai → Kyiv" and CMR + photo "Frankfurt → Kyiv" make Mumbai ✈ Frankfurt 🚚 Kyiv', () => {
    const r = buildRoute(
      [
        { from: 'MUMBAI (EX BOMBAY)', to: "KYIV INT'L AIRPORT", mode: 'air', ref: '098-31298724', t: Date.UTC(2026, 6, 14) },
        { from: 'Mumbai (ex Bombay)', to: 'Kyiv', mode: 'air', ref: 'AID0009199', t: Date.UTC(2026, 6, 14) },
        { from: 'Frankfurt Airport', to: 'Kyiv', mode: 'road', ref: 'SAID0009199', t: Date.UTC(2026, 6, 23) },
        { from: 'Frankfurt Airport, Germany', to: 'Kiev, Ukraine', mode: 'road', ref: 'SAID0009199', t: Date.UTC(2026, 6, 23) },
      ],
      'Bila Tserkva',
      { ref: '20400540693174', t: Date.UTC(2026, 6, 31) },
    );
    expect(r.stops.map((s) => s.name)).toEqual(['Mumbai', 'Frankfurt', 'Kyiv', 'Bila Tserkva']);
    expect(r.legs.map((l) => l.mode)).toEqual(['air', 'road', 'road']);
    expect(r.stops[1]!.date).toBe('23.07');
  });

  it('a bill and its act for the same broker service are counted once', () => {
    const f = buildFacts({
      ...base,
      docs: [...base.docs, { file_name: 'акт.pdf', doc_type: 'other', fields: { service_kind: 'broker', total_value: 6163, currency: 'UAH', buyer: 'ТОВ «ТЕХІНФОРМ ПЛЮС»' } }],
    });
    expect(f.money.servicesUah).toEqual([{ kind: 'broker', amountUah: 6163 }]);
  });

  it('risk details drop file lists', () => {
    expect(compactDetail('вага нетто, кг: 25 (26UA1.pdf, INVOICE.pdf) → 32 (DEP-1-DE2329875-0071.pdf)')).toBe('вага нетто, кг: 25 → 32');
  });
});
