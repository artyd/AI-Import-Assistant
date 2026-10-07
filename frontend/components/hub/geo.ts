// Client-side geometry for smooth map animation (mirrors src/services/hub/geo.ts).

import type { LatLng } from "@/lib/hub";

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x =
    Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Point + heading at fraction t of a path, plus the path split at that point. */
export function splitAt(path: LatLng[], t: number): { point: LatLng; heading: number; done: LatLng[]; rest: LatLng[] } {
  const first = path[0]!;
  if (path.length < 2) return { point: first, heading: 0, done: [first], rest: [first] };
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const d = haversineKm(path[i - 1]!, path[i]!);
    seg.push(d);
    total += d;
  }
  let target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < seg.length; i += 1) {
    const len = seg[i]!;
    const a = path[i]!;
    const b = path[i + 1]!;
    if (target <= len || i === seg.length - 1) {
      const f = len === 0 ? 0 : Math.min(1, target / len);
      const point: LatLng = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      return {
        point,
        heading: bearing(a, b),
        done: [...path.slice(0, i + 1), point],
        rest: [point, ...path.slice(i + 1)],
      };
    }
    target -= len;
  }
  const last = path[path.length - 1]!;
  return { point: last, heading: 0, done: path, rest: [last] };
}

/** Dead-reckoning: move `km` from p along course `cog`. */
export function advance(p: LatLng, cog: number, km: number): LatLng {
  const dLat = (km * Math.cos(rad(cog))) / 111.32;
  const dLng = (km * Math.sin(rad(cog))) / (111.32 * Math.max(0.2, Math.cos(rad(p[0]))));
  return [p[0] + dLat, p[1] + dLng];
}

export function lerp(a: LatLng, b: LatLng, f: number): LatLng {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

const smoothCache = new WeakMap<LatLng[], LatLng[]>();

/**
 * Softened polyline for display: a 2-point leg becomes a gentle arc (quadratic
 * Bézier bowed ~12% of its length), longer paths get Chaikin corner-cutting so
 * sea lanes bend smoothly at chokepoints instead of turning at sharp angles.
 * Endpoints are kept exactly. Memoised per input array.
 */
export function smoothPath(path: LatLng[], iterations = 3): LatLng[] {
  if (path.length < 2) return path;
  const hit = smoothCache.get(path);
  if (hit) return hit;
  let out: LatLng[];
  if (path.length === 2) {
    const [a, b] = path as [LatLng, LatLng];
    const mid: LatLng = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // Perpendicular offset (in degrees, good enough for display).
    const dx = b[1] - a[1];
    const dy = b[0] - a[0];
    const ctrl: LatLng = [mid[0] + dx * 0.12, mid[1] - dy * 0.12];
    out = [];
    for (let i = 0; i <= 24; i += 1) {
      const t = i / 24;
      const u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * ctrl[0] + t * t * b[0], u * u * a[1] + 2 * u * t * ctrl[1] + t * t * b[1]]);
    }
  } else {
    let p = path;
    for (let k = 0; k < iterations; k += 1) {
      const next: LatLng[] = [p[0]!];
      for (let i = 0; i < p.length - 1; i += 1) {
        const a = p[i]!;
        const b = p[i + 1]!;
        next.push(lerp(a, b, 0.25), lerp(a, b, 0.75));
      }
      next.push(p[p.length - 1]!);
      p = next;
    }
    out = p;
  }
  smoothCache.set(path, out);
  return out;
}

/** Fraction (0..1) of the path length at the vertex nearest to `p`. */
export function progressOnPath(path: LatLng[], p: LatLng): number {
  if (path.length < 2) return 0;
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i += 1) cum.push(cum[i - 1]! + haversineKm(path[i - 1]!, path[i]!));
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.length; i += 1) {
    const d = haversineKm(path[i]!, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const total = cum[cum.length - 1]!;
  return total === 0 ? 0 : cum[best]! / total;
}
