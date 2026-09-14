import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/hook.js';
import { query } from '../db/pool.js';
import { getTrackingProvider, type ShipmentInput } from '../services/tracking/index.js';

/**
 * Phase D — Map. Read-only reference atlas (ports + routes, shared/non-scoped)
 * plus the current user's shipments turned into live vessel markers by the
 * configured tracking provider (DEMO until AIS_API_KEY is set). Every route is
 * authenticated; shipments are owner-scoped via the workspaces table.
 */

interface PortRow {
  code: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  kind: 'sea' | 'inland' | 'customs';
}

interface RouteRow {
  id: string;
  from_code: string;
  to_code: string;
  mode: 'sea' | 'land';
  risk: 'low' | 'medium' | 'high';
  waypoints: unknown;
}

export async function mapRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/map/ports — reference ports (shared atlas).
  app.get('/api/map/ports', async (_req, reply) => {
    const { rows } = await query<PortRow>(
      'SELECT code, name, country, lat, lng, kind FROM ports ORDER BY code',
    );
    return reply.send({ ports: rows });
  });

  // GET /api/map/routes — representative routes with polyline waypoints.
  app.get('/api/map/routes', async (_req, reply) => {
    const { rows } = await query<RouteRow>(
      'SELECT id, from_code, to_code, mode, risk, waypoints FROM routes ORDER BY id',
    );
    return reply.send({ routes: rows });
  });

  // GET /api/map/shipments — the user's shipments as live vessel markers. Each
  // shipment is assigned a seeded route round-robin so DEMO positions look
  // plausible, then handed to the tracking provider.
  app.get('/api/map/shipments', async (req, reply) => {
    const { rows: routeRows } = await query<{ id: string }>(
      'SELECT id FROM routes ORDER BY id',
    );
    const routeIds = routeRows.map((r) => r.id);

    const { rows: wsRows } = await query<{ number: string; supplier: string; status: string }>(
      'SELECT number, supplier, status FROM workspaces WHERE owner_id = $1 ORDER BY created_at',
      [req.user!.sub],
    );

    const shipments: ShipmentInput[] = wsRows.map((w, i) => ({
      no: w.number,
      supplier: w.supplier,
      status: w.status,
      routeId: routeIds.length ? routeIds[i % routeIds.length] : undefined,
    }));

    const vessels = await getTrackingProvider().getShipmentPositions(shipments);
    return reply.send({ vessels });
  });
}
