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
