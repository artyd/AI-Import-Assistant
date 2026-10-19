import { describe, expect, it } from 'vitest';
import { detectNumber, isValidAwb, isValidContainer, scanTrackingNumbers } from '../detect.js';
import { trackingUrl } from '../carriers.js';

describe('hub number detection', () => {
  it('validates ISO 6346 check digits', () => {
    expect(isValidContainer('CSQU3054383')).toBe(true);
    expect(isValidContainer('CSQU3054384')).toBe(false);
    expect(isValidContainer('MSKU1234565')).toBe(true);
  });

  it('maps container owner codes to carriers', () => {
    expect(detectNumber('MSKU 123456-5').candidates[0]).toMatchObject({ carrier: 'maersk', kind: 'container', mode: 'sea', confidence: 1 });
    expect(detectNumber('medu7654325').candidates[0]).toMatchObject({ carrier: 'msc', kind: 'container' });
    // Lessor box: valid number, operating line unknown.
    expect(detectNumber('TGHU1000002').candidates[0]).toMatchObject({ carrier: 'sea-generic', kind: 'container' });
  });

  it('recognises AWBs by airline prefix with the mod-7 check', () => {
    expect(isValidAwb('15712345675')).toBe(true);
    expect(detectNumber('157-1234 5675').candidates[0]).toMatchObject({ carrier: 'qr', kind: 'awb', mode: 'air' });
    expect(detectNumber('235-33333333').candidates[0]).toMatchObject({ carrier: 'tk' });
  });

  it('recognises couriers and Ukrainian domestic waybills', () => {
    expect(detectNumber('1Z999AA10123456784').candidates[0]?.carrier).toBe('ups');
    expect(detectNumber('20450123456789').candidates[0]).toMatchObject({ carrier: 'novaposhta', mode: 'domestic' });
    expect(detectNumber('RB123456785UA').candidates[0]?.carrier).toBe('ukrposhta');
    expect(detectNumber('LP123456789CN').candidates[0]?.carrier).toBe('upu');
    expect(detectNumber('1234567890').candidates[0]?.carrier).toBe('dhl');
  });

  it('recognises B/L numbers with a carrier prefix', () => {
    expect(detectNumber('MEDUAB123456').candidates[0]).toMatchObject({ carrier: 'msc', kind: 'bl' });
    expect(detectNumber('EGLV142300012345').candidates[0]).toMatchObject({ carrier: 'evergreen', kind: 'bl' });
  });

  it('returns no candidates for garbage', () => {
    expect(detectNumber('hello').candidates).toHaveLength(0);
  });

  it('scans documents only for high-confidence numbers', () => {
    const text = `Container No: MSKU 123456 5\nBad: MSKU1234566\nAWB 157-1234 5675\nB/L No. MEDUAB123456\nInvoice 2026-0001`;
    const hits = scanTrackingNumbers(text).map((h) => h.number);
    expect(hits).toEqual(expect.arrayContaining(['MSKU1234565', '15712345675', 'MEDUAB123456']));
    expect(hits).not.toContain('MSKU1234566');
  });

  it('builds public tracking links', () => {
    expect(trackingUrl('maersk', 'MSKU1234565')).toBe('https://www.maersk.com/tracking/MSKU1234565');
    expect(trackingUrl('qr', '15712345675')).toContain('157-12345675');
  });
});
