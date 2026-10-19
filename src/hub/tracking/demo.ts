import { query } from '../../db/pool.js';
import { interpolateAlong, stableProgress, type LatLng } from './geo.js';
import type { ShipmentInput, TrackingProvider, VesselPosition } from './provider.js';

/**
 * DEMO tracking provider. Places one marker per shipment at a deterministic point
 * along its route's waypoints — a ship (🚢) for sea routes, a truck (🚚) for land.
 * Progress along the route is a stable hash of the shipment number (never random /
 * time-based), so the map is reproducible. Reads route geometry from the DB but
 * makes no network calls.
 */

interface RouteRow {
  id: string;
  mode: 'sea' | 'land';
  waypoints: unknown;
}

/** pg parses jsonb into JS; coerce it to a well-typed [lat,lng][] defensively. */
function toWaypoints(raw: unknown): LatLng[] {
  if (!Array.isArray(raw)) return [];
  const out: LatLng[] = [];
  for (const pt of raw) {
    if (Array.isArray(pt) && typeof pt[0] === 'number' && typeof pt[1] === 'number') {
      out.push([pt[0], pt[1]]);
    }
  }
  return out;
}

export class DemoTrackingProvider implements TrackingProvider {
  readonly id = 'demo';

  async getShipmentPositions(shipments: ShipmentInput[]): Promise<VesselPosition[]> {
    if (shipments.length === 0) return [];

    const { rows } = await query<RouteRow>('SELECT id, mode, waypoints FROM routes');
    const routes = new Map<string, { mode: 'sea' | 'land'; waypoints: LatLng[] }>();
    for (const r of rows) {
      routes.set(r.id, { mode: r.mode, waypoints: toWaypoints(r.waypoints) });
    }

    const vessels: VesselPosition[] = [];
    for (const s of shipments) {
      const route = s.routeId ? routes.get(s.routeId) : undefined;
      if (!route || route.waypoints.length === 0) continue; // no geometry ⇒ no marker

      const [lat, lng] = interpolateAlong(route.waypoints, stableProgress(s.no));
      const kind = route.mode === 'land' ? 'truck' : 'ship';
      const icon = kind === 'truck' ? '🚚' : '🚢';
      const name = s.supplier || s.no;

      vessels.push({
        id: s.no,
        kind,
        label: `${icon} ${name}`,
        lat,
        lng,
        status: s.status,
        routeId: s.routeId ?? null,
      });
    }
    return vessels;
  }
}
