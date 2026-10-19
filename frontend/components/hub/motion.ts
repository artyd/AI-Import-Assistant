// Hub motion (pure, no Leaflet): where a marker should be at a given moment.
// HubCanvas only applies these positions to its markers.

import { effDeparted, effEta, type LatLng, type Track } from "@/lib/hub";
import { advance, lerp, smoothPath, splitAt } from "./geo";

/** Position of a marker gliding from `from` to `to` (cubic ease-out), or null once it arrived. */
export function glidePosition(from: LatLng, to: LatLng, start: number, ts: number, glideMs: number): LatLng | null {
  const f = Math.min(1, (ts - start) / glideMs);
  if (f >= 1) return null;
  const e = 1 - (1 - f) ** 3;
  return lerp(from, to, e);
}

/**
 * An in-transit estimate keeps creeping along its lane between polls: the
 * share of the trip elapsed at `wall` (clamped to 2–97 %, so it never claims
 * to have arrived or not to have left). Null when the item has no estimate.
 */
export function estimatePosition(item: Track, wall: number): { point: LatLng; heading: number } | null {
  const dep = effDeparted(item);
  const eta = effEta(item);
  if (item.live?.positionSource !== "estimate" || !dep || !eta) return null;
  const t0 = new Date(dep).getTime();
  const t1 = new Date(eta).getTime();
  if (t1 <= t0) return null;
  const t = Math.max(0.02, Math.min(0.97, (wall - t0) / (t1 - t0)));
  return splitAt(smoothPath(item.live.path), t);
}

/** AIS dead reckoning: drift from the last fix by course/speed, capped at `maxMs`. */
export function deadReckon(
  base: LatLng,
  baseAt: number,
  v: { sog?: number | null; cog?: number | null },
  wall: number,
  maxMs: number,
): LatLng | null {
  const { sog, cog } = v;
  if (sog == null || cog == null || sog < 0.5) return null;
  const dt = Math.min(wall - baseAt, maxMs);
  return advance(base, cog, (sog * 1.852 * dt) / 3_600_000);
}
