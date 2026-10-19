/**
 * Hub geometry: great-circle maths, a coarse global sea-lane graph (so a vessel
 * between Ningbo and Odesa is drawn through Malacca → Suez → Bosporus instead of
 * across Asia), air arcs and progress interpolation along a path.
 *
 * Pure — no I/O, no clock. Unit-tested in __tests__/geo.spec.ts.
 */

export type LatLng = [number, number];

const R = 6371; // km
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a→b in degrees (0 = north, clockwise). */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x =
    Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Great-circle arc a→b as `steps`+1 points (used for air legs). */
export function greatCircle(a: LatLng, b: LatLng, steps = 48): LatLng[] {
  const φ1 = rad(a[0]);
  const λ1 = rad(a[1]);
  const φ2 = rad(b[0]);
  const λ2 = rad(b[1]);
  const d =
    2 *
    Math.asin(
      Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2),
    );
  if (d === 0) return [a, b];
  const out: LatLng[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    out.push([deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))]);
  }
  return out;
}

export function pathLengthKm(path: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += haversineKm(path[i - 1]!, path[i]!);
  return total;
}

/** Point + heading at fraction t (0..1) of a path's length. */
export function pointAlong(path: LatLng[], t: number): { point: LatLng; heading: number } {
  const first = path[0];
  if (!first) throw new Error('pointAlong: empty path');
  if (path.length === 1) return { point: first, heading: 0 };
  const clamped = Math.max(0, Math.min(1, t));
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const d = haversineKm(path[i - 1]!, path[i]!);
    seg.push(d);
    total += d;
  }
  let target = clamped * total;
  for (let i = 0; i < seg.length; i += 1) {
    const len = seg[i]!;
    const a = path[i]!;
    const b = path[i + 1]!;
    if (target <= len || i === seg.length - 1) {
      const f = len === 0 ? 0 : Math.min(1, target / len);
      return { point: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: bearing(a, b) };
    }
    target -= len;
  }
  const last = path[path.length - 1]!;
  return { point: last, heading: bearing(path[path.length - 2]!, last) };
}

/** Fraction (0..1) of the path length at the vertex nearest to `p` — "how far along". */
export function progressOf(path: LatLng[], p: LatLng): number {
  if (path.length < 2) return 0;
  let best = 0;
  let bestD = Infinity;
  let acc = 0;
  let total = 0;
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i += 1) {
    total += haversineKm(path[i - 1]!, path[i]!);
    cum.push(total);
  }
  for (let i = 0; i < path.length; i += 1) {
    const d = haversineKm(path[i]!, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  acc = cum[best]!;
  return total === 0 ? 0 : acc / total;
}

// ── Sea-lane graph ───────────────────────────────────────────────────────────
// Coarse open-water waypoints at the chokepoints and corners every container
// lane between Asia / India / Middle East and Europe / Black Sea passes. Edges
// are straight segments that stay in water. Ports attach to their nearest node.

const NODES: Record<string, LatLng> = {
  bohai: [38.6, 120.4],
  yellow: [35.5, 122.8],
  korea_s: [33.8, 128.6],
  japan_s: [33.8, 136.5],
  tokyo_b: [34.9, 139.9],
  china_e: [30.6, 123.4],
  taiwan_str: [24.2, 119.6],
  taiwan_e: [22.0, 121.5],
  hk_off: [21.9, 114.6],
  scs_n: [17.0, 113.0],
  scs_s: [8.0, 109.5],
  vn_s: [9.5, 107.2],
  gulf_thai: [11.5, 101.5],
  singapore: [1.15, 104.1],
  java: [-5.6, 107.0],
  malacca_mid: [2.6, 101.0],
  malacca_n: [5.8, 97.8],
  aceh_w: [6.2, 94.3],
  bengal: [15.0, 88.5],
  dondra: [5.4, 80.6],
  india_w: [15.5, 71.5],
  arabian: [17.0, 63.0],
  hormuz: [26.3, 56.6],
  gulf: [25.5, 54.5],
  socotra: [13.2, 53.0],
  aden: [12.3, 45.8],
  bab: [12.6, 43.4],
  red_s: [16.5, 41.0],
  red_mid: [21.0, 38.0],
  red_n: [27.0, 34.5],
  suez_s: [29.6, 32.6],
  suez_n: [31.5, 32.35],
  levant: [33.2, 33.5],
  med_e: [33.8, 28.0],
  crete_s: [34.6, 24.5],
  ionian: [36.8, 20.0],
  aegean_s: [36.6, 24.8],
  aegean_n: [39.6, 25.2],
  dardanelles: [40.15, 26.35],
  marmara: [40.8, 28.4],
  bosporus_n: [41.35, 29.15],
  bs_sw: [42.5, 29.0],
  bs_w: [43.6, 29.6],
  bs_nw: [45.0, 30.2],
  odesa_b: [46.2, 30.9],
  bs_s: [42.0, 34.0],
  bs_e: [42.3, 40.5],
  adriatic: [42.5, 16.5],
  adriatic_n: [45.0, 13.3],
  sicily: [37.3, 11.8],
  tyrrhen: [40.0, 11.5],
  ligurian: [43.5, 8.5],
  med_w: [38.2, 4.5],
  alboran: [36.2, -3.0],
  gibraltar: [35.95, -5.75],
  portugal: [38.0, -10.2],
  finisterre: [43.5, -9.9],
  ushant: [48.6, -6.0],
  channel: [50.2, -1.0],
  dover: [51.0, 1.6],
  north_sea: [53.2, 3.8],
  german_b: [54.2, 7.5],
  skagen: [57.9, 10.9],
  kattegat: [56.5, 11.6],
  baltic_w: [54.9, 13.6],
  baltic_s: [55.3, 17.0],
  baltic_e: [57.5, 20.0],
  gulf_riga: [57.8, 23.6],
  gulf_finland: [59.6, 24.0],
  canaries: [28.5, -16.0],
  senegal: [14.5, -18.5],
  guinea: [3.0, 2.5],
  angola: [-12.0, 10.0],
  namibia: [-26.0, 12.5],
  cape: [-35.2, 19.0],
  natal: [-31.0, 32.5],
  mozambique: [-20.0, 41.5],
  ind_sw: [-15.0, 55.0],
  ind_mid: [-3.0, 82.0],
  atl_mid: [40.0, -40.0],
  ny_off: [40.3, -73.3],
  us_se: [31.5, -79.8],
  brazil: [-24.5, -45.0],
  atl_s: [-10.0, -30.0],
  panama: [9.4, -79.9],
  pacific_e: [20.0, -110.0],
  la_off: [33.6, -118.4],
};

const EDGES: Array<[string, string, ('red' | undefined)?]> = [
  ['bohai', 'yellow'],
  ['yellow', 'korea_s'],
  ['yellow', 'china_e'],
  ['korea_s', 'japan_s'],
  ['japan_s', 'tokyo_b'],
  ['korea_s', 'china_e'],
  ['china_e', 'taiwan_str'],
  ['china_e', 'taiwan_e'],
  ['taiwan_str', 'hk_off'],
  ['taiwan_e', 'scs_n'],
  ['hk_off', 'scs_n'],
  ['scs_n', 'scs_s'],
  ['scs_n', 'vn_s'],
  ['vn_s', 'scs_s'],
  ['scs_s', 'singapore'],
  ['scs_s', 'gulf_thai'],
  ['gulf_thai', 'singapore'],
  ['singapore', 'java'],
  ['singapore', 'malacca_mid'],
  ['malacca_mid', 'malacca_n'],
  ['malacca_n', 'aceh_w'],
  ['aceh_w', 'bengal'],
  ['aceh_w', 'dondra'],
  ['aceh_w', 'ind_mid'],
  ['java', 'ind_mid'],
  ['bengal', 'dondra'],
  ['dondra', 'india_w'],
  ['dondra', 'arabian'],
  ['dondra', 'socotra'],
  ['dondra', 'ind_mid'],
  ['india_w', 'arabian'],
  ['arabian', 'hormuz'],
  ['hormuz', 'gulf'],
  ['arabian', 'socotra'],
  ['socotra', 'aden'],
  ['socotra', 'ind_sw'],
  ['aden', 'bab', 'red'],
  ['bab', 'red_s', 'red'],
  ['red_s', 'red_mid', 'red'],
  ['red_mid', 'red_n', 'red'],
  ['red_n', 'suez_s', 'red'],
  ['suez_s', 'suez_n', 'red'],
  ['suez_n', 'levant'],
  ['suez_n', 'med_e'],
  ['levant', 'med_e'],
  ['med_e', 'crete_s'],
  ['crete_s', 'aegean_s'],
  ['crete_s', 'ionian'],
  ['aegean_s', 'aegean_n'],
  ['aegean_n', 'dardanelles'],
  ['dardanelles', 'marmara'],
  ['marmara', 'bosporus_n'],
  ['bosporus_n', 'bs_sw'],
  ['bs_sw', 'bs_w'],
  ['bs_w', 'bs_nw'],
  ['bs_nw', 'odesa_b'],
  ['bs_sw', 'bs_s'],
  ['bs_s', 'bs_e'],
  ['ionian', 'adriatic'],
  ['adriatic', 'adriatic_n'],
  ['ionian', 'sicily'],
  ['sicily', 'tyrrhen'],
  ['tyrrhen', 'ligurian'],
  ['sicily', 'med_w'],
  ['ligurian', 'med_w'],
  ['med_w', 'alboran'],
  ['alboran', 'gibraltar'],
  ['gibraltar', 'portugal'],
  ['gibraltar', 'canaries'],
  ['portugal', 'finisterre'],
  ['finisterre', 'ushant'],
  ['ushant', 'channel'],
  ['channel', 'dover'],
  ['dover', 'north_sea'],
  ['north_sea', 'german_b'],
  ['german_b', 'skagen'],
  ['north_sea', 'skagen'],
  ['skagen', 'kattegat'],
  ['kattegat', 'baltic_w'],
  ['baltic_w', 'baltic_s'],
  ['baltic_s', 'baltic_e'],
  ['baltic_e', 'gulf_riga'],
  ['baltic_e', 'gulf_finland'],
  ['canaries', 'senegal'],
  ['senegal', 'guinea'],
  ['guinea', 'angola'],
  ['angola', 'namibia'],
  ['namibia', 'cape'],
  ['cape', 'natal'],
  ['natal', 'mozambique'],
  ['mozambique', 'ind_sw'],
  ['cape', 'ind_sw'],
  ['ind_sw', 'ind_mid'],
  ['portugal', 'atl_mid'],
  ['ushant', 'atl_mid'],
  ['atl_mid', 'ny_off'],
  ['ny_off', 'us_se'],
  ['us_se', 'panama'],
  ['senegal', 'atl_s'],
  ['atl_s', 'brazil'],
  ['panama', 'pacific_e'],
  ['pacific_e', 'la_off'],
];

interface Adj {
  to: string;
  km: number;
  red: boolean;
}

const GRAPH: Map<string, Adj[]> = (() => {
  const g = new Map<string, Adj[]>();
  for (const k of Object.keys(NODES)) g.set(k, []);
  for (const [a, b, tag] of EDGES) {
    const km = haversineKm(NODES[a]!, NODES[b]!);
    g.get(a)!.push({ to: b, km, red: tag === 'red' });
    g.get(b)!.push({ to: a, km, red: tag === 'red' });
  }
  return g;
})();

function nearestNode(p: LatLng): string {
  let best = '';
  let bestD = Infinity;
  for (const [k, v] of Object.entries(NODES)) {
    const d = haversineKm(p, v);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

export interface SeaRouteOptions {
  /** Avoid the Red Sea / Suez (route via the Cape of Good Hope). */
  avoidRedSea?: boolean;
}

/**
 * Sea path between two coastal points through the lane graph (Dijkstra). Falls
 * back to the straight segment when both ends hang off the same node.
 */
export function seaRoute(from: LatLng, to: LatLng, opts: SeaRouteOptions = {}): LatLng[] {
  const s = nearestNode(from);
  const t = nearestNode(to);
  if (s === t) return [from, to];
  const dist = new Map<string, number>([[s, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  while (true) {
    let u: string | null = null;
    let ud = Infinity;
    for (const [k, d] of dist) {
      if (!done.has(k) && d < ud) {
        ud = d;
        u = k;
      }
    }
    if (u === null || u === t) break;
    done.add(u);
    for (const e of GRAPH.get(u)!) {
      if (opts.avoidRedSea && e.red) continue;
      const nd = ud + e.km;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, u);
      }
    }
  }
  if (!dist.has(t)) return [from, to];
  const nodes: string[] = [t];
  while (nodes[0] !== s) nodes.unshift(prev.get(nodes[0]!)!);
  return [from, ...nodes.map((n) => NODES[n]!), to];
}

/** True when a sea path crosses the Red Sea / Suez lane. */
export function viaRedSea(path: LatLng[]): boolean {
  const bab = NODES.bab!;
  return path.some((p) => haversineKm(p, bab) < 30);
}

export type LegMode = 'sea' | 'air' | 'road' | 'rail' | 'courier' | 'domestic';

/** Geometry for a leg by transport mode. */
export function legPath(mode: LegMode, from: LatLng, to: LatLng, opts: SeaRouteOptions = {}): LatLng[] {
  if (mode === 'sea') return seaRoute(from, to, opts);
  if (mode === 'air' || mode === 'courier') return greatCircle(from, to, 40);
  return [from, to];
}
