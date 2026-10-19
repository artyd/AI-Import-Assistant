import { describe, expect, it } from 'vitest';
import { carriersMentioned } from '../portNews.js';
import { referenceLanes, validRotation } from '../lines.js';

describe('sea lines', () => {
  it('recognises carriers in news text', () => {
    expect(carriersMentioned('Maersk resumes calls at Odesa; MSC keeps Cape routing')).toEqual(['maersk', 'msc']);
    expect(carriersMentioned('CMA CGM та Hapag-Lloyd підвищили надбавки')).toEqual(['cma', 'hapag']);
    expect(carriersMentioned('Компанія Мерск відновила букінги')).toEqual(['maersk']);
    expect(carriersMentioned('One more ship arrived')).toEqual([]);
  });

  it('computes plausible reference transit times from lane distance', () => {
    const lanes = referenceLanes();
    const suez = lanes.find((l) => l.id === 'cn-ods-suez')!;
    const cape = lanes.find((l) => l.id === 'cn-ods-cape')!;
    expect(suez.transitDaysMin).toBeGreaterThan(22);
    expect(suez.transitDaysMax).toBeLessThan(45);
    expect(cape.transitDaysMin).toBeGreaterThan(suez.transitDaysMin + 7);
    expect(cape.distanceNm).toBeGreaterThan(suez.distanceNm + 2500);
    expect(suez.path.length).toBeGreaterThan(10);
  });

  it('accepts only known rotation codes', () => {
    expect(validRotation(['cnsha', 'XXXXX', 'UAODS'])).toEqual(['CNSHA', 'UAODS']);
  });
});
