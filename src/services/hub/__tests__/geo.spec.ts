import { describe, expect, it } from 'vitest';
import { greatCircle, haversineKm, pathLengthKm, pointAlong, seaRoute, viaRedSea } from '../geo.js';
import { matchPlace } from '../places.js';

const NINGBO: [number, number] = [29.93, 121.85];
const ODESA: [number, number] = [46.49, 30.75];

describe('hub geometry', () => {
  it('haversine is sane', () => {
    expect(haversineKm([50.45, 30.52], [52.23, 21.01])).toBeGreaterThan(650);
    expect(haversineKm([50.45, 30.52], [52.23, 21.01])).toBeLessThan(720);
  });

  it('routes Asia → Odesa through Suez and the Bosporus by default', () => {
    const path = seaRoute(NINGBO, ODESA);
    expect(viaRedSea(path)).toBe(true);
    // passes near Istanbul strait
    expect(path.some((p) => haversineKm(p, [41.2, 29.1]) < 80)).toBe(true);
    const km = pathLengthKm(path);
    expect(km).toBeGreaterThan(14000);
    expect(km).toBeLessThan(20000);
  });

  it('routes around the Cape when the Red Sea is avoided', () => {
    const path = seaRoute(NINGBO, ODESA, { avoidRedSea: true });
    expect(viaRedSea(path)).toBe(false);
    expect(path.some((p) => p[0] < -30)).toBe(true);
    expect(pathLengthKm(path)).toBeGreaterThan(pathLengthKm(seaRoute(NINGBO, ODESA)));
  });

  it('interpolates along a path', () => {
    const path = greatCircle([50.34, 30.89], [50.04, 8.56], 20);
    const mid = pointAlong(path, 0.5).point;
    expect(mid[1]).toBeGreaterThan(15);
    expect(mid[1]).toBeLessThan(25);
    expect(pointAlong(path, 0).point).toEqual(path[0]);
  });

  it('matches places from carrier event text', () => {
    expect(matchPlace('SHANGHAI, CN')?.code).toBe('CNSHA');
    expect(matchPlace('Discharged at CONSTANTA terminal')?.code).toBe('ROCND');
    expect(matchPlace('Gdańsk DCT')?.code).toBe('PLGDN');
    expect(matchPlace('UAODS')?.code).toBe('UAODS');
    expect(matchPlace('Arrived at LEJ hub')?.code).toBe('LEJ');
    expect(matchPlace('Shanghai Pudong', 'air')?.code).toBe('PVG');
    expect(matchPlace('Київ, відділення №12')?.code).toBe('UAIEV');
    expect(matchPlace('nowhere land')).toBeUndefined();
  });
});
