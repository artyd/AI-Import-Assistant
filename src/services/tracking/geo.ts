/**
 * Pure geometry helpers for the DEMO tracker. No I/O, no clock, no randomness —
 * positions are reproducible from a shipment number so the map is stable across
 * requests and unit-testable without a DB (see __tests__/geo.spec.ts).
 */

/** An ordered [lat, lng] polyline vertex. */
export type LatLng = readonly [number, number];

/**
 * Deterministic 0..1 progress derived from a stable FNV-1a hash of `seed` (the
 * shipment number). Same input ⇒ same output; intentionally NOT Math.random /
 * Date.now so the demo map never jitters between polls.
 */
export function stableProgress(seed: string): number {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned, then quantise to a 0..0.999 fraction.
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Point at fraction `t` (0..1, clamped) of the total length of a polyline,
 * measured by simple planar segment length on (lat, lng) — accurate enough for a
 * demo marker. Returns the sole vertex for a 1-point line.
 */
export function interpolateAlong(waypoints: readonly LatLng[], t: number): [number, number] {
  const first = waypoints[0];
  if (!first) throw new Error('interpolateAlong: empty waypoints');
  if (waypoints.length === 1) return [first[0], first[1]];

  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;

  const segLen: number[] = [];
  let total = 0;
  for (let i = 1; i < waypoints.length; i += 1) {
    const a = waypoints[i - 1]!;
    const b = waypoints[i]!;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segLen.push(d);
    total += d;
  }
  if (total === 0) return [first[0], first[1]];

  let target = clamped * total;
  for (let i = 0; i < segLen.length; i += 1) {
    const len = segLen[i]!;
    if (target <= len || i === segLen.length - 1) {
      const a = waypoints[i]!;
      const b = waypoints[i + 1]!;
      const f = len === 0 ? 0 : target / len;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    target -= len;
  }

  const last = waypoints[waypoints.length - 1]!;
  return [last[0], last[1]];
}
