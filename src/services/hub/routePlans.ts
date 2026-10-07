import { pool, query } from '../../db/pool.js';
import { getCarrier } from './carriers.js';
import { placeByCode } from './places.js';
import { computePlan, type LegInput, type RouteMode, type TrackFact } from './plan.js';
import { getTracked } from './track.js';
import { haversineKm, seaRoute, type LatLng } from './geo.js';

/**
 * Persistence for planned routes (hub phase 4). Visibility mirrors tracked
 * items: the author, plus the owner of the linked shipment. Every read returns
 * the plan already computed against live tracking (see plan.ts).
 */

interface RouteRow {
  id: string;
  owner_id: string;
  workspace_id: string | null;
  workspace_number: string | null;
  name: string;
  status: 'draft' | 'active' | 'done';
  notes: string;
  created_at: string;
  updated_at: string;
}

interface LegRow {
  id: string;
  route_id: string;
  seq: number;
  mode: RouteMode;
  from_code: string;
  from_name: string;
  from_lat: number | null;
  from_lng: number | null;
  to_code: string;
  to_name: string;
  to_lat: number | null;
  to_lng: number | null;
  carrier: string;
  via: '' | 'suez' | 'cape';
  tracked_id: string | null;
  planned_departure: string | null;
  planned_arrival: string | null;
  cost_amount: string | null;
  cost_currency: string;
  free_days: number | null;
  demurrage_per_day: string | null;
  notes: string;
}

const VISIBLE = `(r.owner_id = $1 OR r.workspace_id IN (SELECT id FROM workspaces WHERE owner_id = $1))`;

function toLeg(l: LegRow): LegInput {
  const pos = (lat: number | null, lng: number | null): LatLng | null => (lat != null && lng != null ? [lat, lng] : null);
  return {
    id: l.id,
    seq: l.seq,
    mode: l.mode,
    from: { code: l.from_code, name: l.from_name, pos: pos(l.from_lat, l.from_lng) },
    to: { code: l.to_code, name: l.to_name, pos: pos(l.to_lat, l.to_lng) },
    carrier: l.carrier,
    via: l.via,
    trackedId: l.tracked_id,
    plannedDeparture: l.planned_departure,
    plannedArrival: l.planned_arrival,
    costAmount: l.cost_amount != null ? Number(l.cost_amount) : null,
    costCurrency: l.cost_currency,
    freeDays: l.free_days,
    demurragePerDay: l.demurrage_per_day != null ? Number(l.demurrage_per_day) : null,
    notes: l.notes,
  };
}

/**
 * The actual path from geocoded carrier events. Consecutive duplicates are
 * dropped; for sea items each hop follows the sea-lane graph so the line never
 * cuts across a continent between two port calls.
 */
export function factPath(points: LatLng[], sea: boolean): LatLng[] {
  const pts = points.filter((p, i) => i === 0 || haversineKm(p, points[i - 1]!) > 5);
  if (!sea || pts.length < 2) return pts;
  const out: LatLng[] = [pts[0]!];
  for (let i = 1; i < pts.length; i += 1) out.push(...seaRoute(pts[i - 1]!, pts[i]!).slice(1));
  return out;
}

async function loadFacts(ids: string[]): Promise<Map<string, TrackFact & { number: string; label: string; statusLabel: string }>> {
  const out = new Map<string, TrackFact & { number: string; label: string; statusLabel: string }>();
  if (ids.length === 0) return out;
  const { rows } = await query<{
    id: string;
    number: string;
    label: string;
    status: string;
    departed_at: string | null;
    arrived_at: string | null;
    eta: string | null;
    mode: string;
  }>('SELECT id, number, label, status, departed_at, arrived_at, eta, mode FROM tracked_items WHERE id = ANY($1)', [ids]);
  const ev = await query<{ tracked_id: string; lat: number; lng: number }>(
    `SELECT tracked_id, lat, lng FROM tracking_events
     WHERE tracked_id = ANY($1) AND NOT planned AND lat IS NOT NULL ORDER BY at NULLS LAST, created_at`,
    [ids],
  );
  for (const r of rows) {
    out.set(r.id, {
      number: r.number,
      label: r.label,
      statusLabel: r.status,
      status: r.status,
      departedAt: r.departed_at,
      arrivedAt: r.arrived_at,
      eta: r.eta,
      path: factPath(
        ev.rows.filter((e) => e.tracked_id === r.id).map((e) => [e.lat, e.lng] as LatLng),
        r.mode === 'sea',
      ),
    });
  }
  return out;
}

async function assemble(route: RouteRow, legRows: LegRow[]) {
  const legs = legRows.map(toLeg);
  const facts = await loadFacts(legs.map((l) => l.trackedId).filter((x): x is string => !!x));
  const plan = computePlan(legs, facts);
  const byId = new Map(plan.legs.map((l) => [l.id, l]));
  return {
    id: route.id,
    name: route.name,
    status: route.status,
    notes: route.notes,
    workspaceId: route.workspace_id,
    workspaceNumber: route.workspace_number,
    createdAt: route.created_at,
    updatedAt: route.updated_at,
    summary: {
      distanceKm: plan.distanceKm,
      plannedStart: plan.plannedStart,
      plannedEnd: plan.plannedEnd,
      projectedEnd: plan.projectedEnd,
      delayDays: plan.delayDays,
      costs: plan.costs,
      demurrage: plan.demurrage,
      health: plan.health,
    },
    legs: legs.map((l) => {
      const f = l.trackedId ? facts.get(l.trackedId) : undefined;
      return {
        ...l,
        carrierName: getCarrier(l.carrier)?.name ?? l.carrier,
        tracked: f ? { id: l.trackedId!, number: f.number, label: f.label, status: f.status } : null,
        computed: byId.get(l.id)!,
      };
    }),
  };
}

export type RouteDto = Awaited<ReturnType<typeof assemble>>;

const ROUTE_SELECT = `SELECT r.*, w.number AS workspace_number FROM planned_routes r
  LEFT JOIN workspaces w ON w.id = r.workspace_id`;

export async function listRoutes(userId: string): Promise<RouteDto[]> {
  const { rows } = await query<RouteRow>(`${ROUTE_SELECT} WHERE ${VISIBLE} ORDER BY r.updated_at DESC LIMIT 200`, [userId]);
  if (rows.length === 0) return [];
  const legs = await query<LegRow>('SELECT * FROM route_legs WHERE route_id = ANY($1) ORDER BY seq', [rows.map((r) => r.id)]);
  return Promise.all(rows.map((r) => assemble(r, legs.rows.filter((l) => l.route_id === r.id))));
}

export async function getRoute(userId: string, id: string): Promise<RouteDto | null> {
  const { rows } = await query<RouteRow>(`${ROUTE_SELECT} WHERE r.id = $2 AND ${VISIBLE}`, [userId, id]);
  const r = rows[0];
  if (!r) return null;
  const legs = await query<LegRow>('SELECT * FROM route_legs WHERE route_id = $1 ORDER BY seq', [id]);
  return assemble(r, legs.rows);
}

export interface PointInput {
  code?: string;
  name?: string;
  lat?: number;
  lng?: number;
}

export interface LegBody {
  mode: RouteMode;
  from: PointInput;
  to?: PointInput;
  carrier?: string;
  via?: '' | 'suez' | 'cape';
  trackedId?: string | null;
  plannedDeparture?: string | null;
  plannedArrival?: string | null;
  costAmount?: number | null;
  costCurrency?: string;
  freeDays?: number | null;
  demurragePerDay?: number | null;
  notes?: string;
}

export interface RouteBody {
  name: string;
  workspaceId?: string | null;
  status?: 'draft' | 'active' | 'done';
  notes?: string;
  legs: LegBody[];
}

/** Resolve a point: a gazetteer code wins; else explicit coordinates + name. */
export function resolvePoint(p: PointInput | undefined): { code: string; name: string; lat: number | null; lng: number | null } {
  if (!p) return { code: '', name: '', lat: null, lng: null };
  const place = p.code ? placeByCode(p.code) : undefined;
  if (place) return { code: place.code, name: place.name, lat: place.lat, lng: place.lng };
  const ok = typeof p.lat === 'number' && typeof p.lng === 'number' && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  return {
    code: '',
    name: (p.name ?? '').slice(0, 120) || (ok ? `Точка ${p.lat!.toFixed(2)}, ${p.lng!.toFixed(2)}` : ''),
    lat: ok ? p.lat! : null,
    lng: ok ? p.lng! : null,
  };
}

export class RouteError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function saveRoute(userId: string, body: RouteBody, id?: string): Promise<string> {
  // Only tracked items the user can see may be bound to a leg.
  for (const l of body.legs) {
    if (l.trackedId && !(await getTracked(userId, l.trackedId))) throw new RouteError('Трек не знайдено.', 404);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let routeId = id;
    if (routeId) {
      const { rowCount } = await client.query(
        `UPDATE planned_routes r SET name = $3, workspace_id = $4, status = $5, notes = $6, updated_at = now()
         WHERE r.id = $2 AND ${VISIBLE}`,
        [userId, routeId, body.name.slice(0, 120), body.workspaceId ?? null, body.status ?? 'draft', (body.notes ?? '').slice(0, 1000)],
      );
      if (!rowCount) throw new RouteError('Маршрут не знайдено.', 404);
      await client.query('DELETE FROM route_legs WHERE route_id = $1', [routeId]);
    } else {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO planned_routes (owner_id, workspace_id, name, status, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, body.workspaceId ?? null, body.name.slice(0, 120), body.status ?? 'draft', (body.notes ?? '').slice(0, 1000)],
      );
      routeId = rows[0]!.id;
    }
    let seq = 0;
    for (const l of body.legs) {
      const from = resolvePoint(l.from);
      const to = l.mode === 'customs' ? from : resolvePoint(l.to);
      await client.query(
        `INSERT INTO route_legs (route_id, seq, mode, from_code, from_name, from_lat, from_lng, to_code, to_name,
           to_lat, to_lng, carrier, via, tracked_id, planned_departure, planned_arrival, cost_amount, cost_currency,
           free_days, demurrage_per_day, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [
          routeId,
          seq++,
          l.mode,
          from.code,
          from.name,
          from.lat,
          from.lng,
          to.code,
          to.name,
          to.lat,
          to.lng,
          l.carrier && getCarrier(l.carrier) ? l.carrier : '',
          l.mode === 'sea' ? (l.via ?? '') : '',
          l.trackedId ?? null,
          l.plannedDeparture ?? null,
          l.plannedArrival ?? null,
          l.costAmount ?? null,
          (l.costCurrency ?? 'USD').toUpperCase().slice(0, 3),
          l.mode === 'sea' ? (l.freeDays ?? null) : null,
          l.mode === 'sea' ? (l.demurragePerDay ?? null) : null,
          (l.notes ?? '').slice(0, 500),
        ],
      );
    }
    await client.query('COMMIT');
    return routeId!;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteRoute(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM planned_routes WHERE id = $1 AND owner_id = $2', [id, userId]);
  return (rowCount ?? 0) > 0;
}
