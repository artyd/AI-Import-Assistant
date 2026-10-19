import { describe, expect, it } from 'vitest';
import { parseT17, t17Status } from '../apiSources.js';

describe('t17Status', () => {
  it('maps 17TRACK main statuses to hub statuses', () => {
    expect(t17Status('InfoReceived')).toBe('info');
    expect(t17Status('InTransit')).toBe('in_transit');
    expect(t17Status('AvailableForPickup')).toBe('out_for_delivery');
    expect(t17Status('OutForDelivery')).toBe('out_for_delivery');
    expect(t17Status('Delivered')).toBe('delivered');
    expect(t17Status('DeliveryFailure')).toBe('exception');
    expect(t17Status('Exception', 'Exception_Returning')).toBe('exception');
    expect(t17Status('NotFound')).toBe('unknown');
    expect(t17Status('Expired')).toBe('unknown');
  });

  it('treats a customs sub-status as customs', () => {
    expect(t17Status('InTransit', 'InTransit_CustomsProcessing')).toBe('customs');
  });
});

describe('parseT17', () => {
  const entry = {
    number: 'RR123456789CN',
    track_info: {
      shipping_info: {
        shipper_address: { country: 'CN', city: 'Shenzhen' },
        recipient_address: { country: 'UA', city: 'Kyiv' },
      },
      latest_status: { status: 'InTransit', sub_status: 'InTransit_Other' },
      time_metrics: { estimated_delivery_date: { from: '2026-10-14T00:00:00Z', to: '2026-10-16T00:00:00Z' } },
      tracking: {
        providers: [
          {
            provider: { name: 'China Post' },
            events: [
              { time_utc: '2026-10-03T08:00:00Z', description: 'Departed from origin', location: 'Shenzhen' },
              { time_utc: '2026-10-01T10:00:00Z', description: 'Accepted', address: { city: 'Shenzhen', country: 'CN' } },
            ],
          },
          {
            provider: { name: 'Укрпошта' },
            events: [
              // duplicate of the origin-carrier event — must be dropped
              { time_utc: '2026-10-03T08:00:00Z', description: 'Departed from origin', location: 'Shenzhen' },
              { time_utc: '2026-10-07T12:00:00Z', description: 'Arrived in destination country', location: 'Kyiv' },
            ],
          },
        ],
      },
    },
  };

  it('extracts status, route, ETA and de-duplicated events in time order', () => {
    const r = parseT17(entry);
    expect(r.found).toBe(true);
    expect(r.status).toBe('in_transit');
    expect(r.source).toBe('api:17track');
    expect(r.origin).toBe('Shenzhen, CN');
    expect(r.destination).toBe('Kyiv, UA');
    expect(r.eta).toBe('2026-10-16T00:00:00.000Z');
    expect(r.events.map((e) => e.description)).toEqual([
      'Accepted',
      'Departed from origin',
      'Arrived in destination country',
    ]);
    expect(r.events[0]!.location).toBe('Shenzhen, CN');
    expect(r.statusText).toBe('Arrived in destination country');
    expect(r.departedAt).toBe('2026-10-01T10:00:00.000Z');
    expect(r.arrivedAt).toBeNull();
  });

  it('reports not-found when 17TRACK has nothing yet', () => {
    const r = parseT17({ number: 'X', track_info: { latest_status: { status: 'NotFound' }, tracking: { providers: [] } } });
    expect(r.found).toBe(false);
    expect(r.status).toBe('unknown');
  });

  it('sets arrivedAt from the last event when delivered', () => {
    const r = parseT17({
      track_info: {
        latest_status: { status: 'Delivered' },
        tracking: { providers: [{ events: [{ time_utc: '2026-10-09T09:30:00Z', description: 'Delivered' }] }] },
      },
    });
    expect(r.status).toBe('delivered');
    expect(r.arrivedAt).toBe('2026-10-09T09:30:00.000Z');
  });
});
