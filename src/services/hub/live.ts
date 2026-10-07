import { query } from '../../db/pool.js';
import { legPath, pointAlong, progressOf, type LatLng, type LegMode } from './geo.js';
import { listEvents, listTracked, serializeTracked, type TrackedRow } from './track.js';

/**
 * Live-map positions for the hub. For each visible tracked item:
 *
 *   ais       — a fresh (<6h) AIS fix of the item's vessel (aisstream.io)
 *   estimate  — in transit with departure + ETA known: interpolated along the
 *               mode's geometry (sea lanes / great-circle / road) by elapsed time
 *   event     — the last actual carrier event that we could geocode
 *   origin / destination — before departure / after delivery
 *
 * `positionSource` is always returned so the UI can say "орієнтовно" for
 * estimates instead of pretending to know an exact position.
 */

export type PositionSource = 'ais' | 'estimate' | 'event' | 'origin' | 'destination';

export interface LiveItem {
  id: string;
  pos: LatLng | null;
  heading: number;
  path: LatLng[];
  progress: number;
  positionSource: PositionSource | null;
  vessel: { name: string; sog: number | null; updatedAt: string } | null;
}

interface VesselRow {
  mmsi: string;
  name: string;
  lat: number;
  lng: number;
  cog: number | null;
  sog: number | null;
  updated_at: string;
}

function geomMode(r: TrackedRow): LegMode {
  if (r.mode === 'sea') return 'sea';
  if (r.mode === 'air') return 'air';
  if (r.mode === 'domestic') return 'road';
  // Courier: international legs fly, in-country legs drive.
  const o = r.origin_lat != null ? [r.origin_lat, r.origin_lng] : null;
  const d = r.dest_lat != null ? [r.dest_lat, r.dest_lng] : null;
  if (o && d && Math.abs(o[0]! - d[0]!) + Math.abs(o[1]! - d[1]!) < 12) return 'road';
  return 'air';
}

async function vesselFor(r: TrackedRow): Promise<VesselRow | null> {
  if (r.mode !== 'sea' || (!r.vessel_mmsi && !r.vessel_name)) return null;
  const { rows } = await query<VesselRow>(
    `SELECT mmsi, name, lat, lng, cog, sog, updated_at FROM vessel_positions
     WHERE (mmsi = $1 OR ($2 <> '' AND upper(name) = upper($2)))
       AND updated_at > now() - interval '6 hours'
     ORDER BY updated_at DESC LIMIT 1`,
    [r.vessel_mmsi || '-', r.vessel_name],
  );
  return rows[0] ?? null;
}

export async function liveItem(r: TrackedRow, now = Date.now()): Promise<LiveItem> {
  const o: LatLng | null = r.origin_lat != null && r.origin_lng != null ? [r.origin_lat, r.origin_lng] : null;
  const d: LatLng | null = r.dest_lat != null && r.dest_lng != null ? [r.dest_lat, r.dest_lng] : null;
  const path = o && d ? legPath(geomMode(r), o, d) : [];
  const base: LiveItem = { id: r.id, pos: null, heading: 0, path, progress: 0, positionSource: null, vessel: null };

  if (r.status === 'delivered' && d) return { ...base, pos: d, progress: 1, positionSource: 'destination' };

  const v = await vesselFor(r);
  if (v) {
    const pos: LatLng = [v.lat, v.lng];
    return {
      ...base,
      pos,
      heading: v.cog ?? 0,
      progress: path.length ? progressOf(path, pos) : 0,
      positionSource: 'ais',
      vessel: { name: v.name, sog: v.sog, updatedAt: v.updated_at },
    };
  }

  const inMotion = ['in_transit', 'info', 'customs'].includes(r.status);
  if (path.length && r.departed_at && r.eta && inMotion) {
    const t0 = new Date(r.departed_at).getTime();
    const t1 = new Date(r.eta).getTime();
    if (t1 > t0) {
      const t = Math.max(0.02, Math.min(0.97, (now - t0) / (t1 - t0)));
      const { point, heading } = pointAlong(path, t);
      return { ...base, pos: point, heading, progress: t, positionSource: 'estimate' };
    }
  }

  const events = await listEvents(r.id);
  const lastGeo = events.filter((e) => !e.planned && e.lat != null && e.lng != null).at(-1);
  if (lastGeo) {
    const pos: LatLng = [lastGeo.lat!, lastGeo.lng!];
    const progress = path.length ? progressOf(path, pos) : 0;
    const heading = path.length ? pointAlong(path, Math.min(0.99, progress + 0.01)).heading : 0;
    return { ...base, pos, heading, progress, positionSource: 'event' };
  }
  if (o) {
    const heading = path.length > 1 ? pointAlong(path, 0.01).heading : 0;
    return { ...base, pos: o, heading, positionSource: 'origin' };
  }
  return base;
}

export interface AmbientVessel {
  mmsi: string;
  name: string;
  lat: number;
  lng: number;
  cog: number | null;
  sog: number | null;
  type: number | null;
}

export async function ambientVessels(limit = 1500): Promise<AmbientVessel[]> {
  const { rows } = await query<AmbientVessel & { ship_type: number | null }>(
    `SELECT mmsi, name, lat, lng, cog, sog, ship_type FROM vessel_positions
     WHERE updated_at > now() - interval '2 hours'
     ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ mmsi: r.mmsi, name: r.name, lat: r.lat, lng: r.lng, cog: r.cog, sog: r.sog, type: r.ship_type }));
}

/** Everything the live map needs in one call. */
export async function liveSnapshot(userId: string) {
  const items = await listTracked(userId);
  const live = await Promise.all(items.map((r) => liveItem(r)));
  const byId = new Map(live.map((l) => [l.id, l]));
  return {
    items: items.map((r) => ({ ...serializeTracked(r), live: byId.get(r.id)! })),
    vessels: await ambientVessels(),
    serverTime: new Date().toISOString(),
  };
}
