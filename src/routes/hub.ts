import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { query } from '../db/pool.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { CARRIERS, getCarrier } from '../services/hub/carriers.js';
import { detectNumber } from '../services/hub/detect.js';
import { trackingSuggestions } from '../services/hub/suggest.js';
import { addMark, confirmMark, getPort, listPorts, PORT_STATUSES, setFavorite } from '../services/hub/ports.js';
import { liveSnapshot } from '../services/hub/live.js';
import {
  addTracked,
  getTracked,
  HubError,
  listEvents,
  listTracked,
  refreshTracked,
  serializeTracked,
} from '../services/hub/track.js';

/**
 * Logistics hub — Phase 1: tracking by number + live map.
 *
 * Every route is authenticated. A tracked item is visible to the user who added
 * it and to the owner of the shipment it is linked to; linking requires owning
 * that shipment (getOwnedWorkspace → 404 on miss, never leaking existence).
 */

const idParams = z.object({ id: z.string().uuid() });

const addBody = z.object({
  number: z.string().trim().min(4).max(60),
  carrier: z.string().trim().max(40).optional(),
  label: z.string().trim().max(120).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
});

const patchBody = z.object({
  label: z.string().trim().max(120).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  carrier: z.string().trim().max(40).optional(),
  archived: z.boolean().optional(),
});

/** Manual refresh at most once per this many ms per item (carrier pages are slow). */
const MANUAL_REFRESH_MIN_MS = 2 * 60_000;

function sendHubError(reply: FastifyReply, err: unknown) {
  if (err instanceof HubError) return reply.status(err.status).send({ error: err.message });
  throw err;
}

export async function hubRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/hub/carriers — the registry (for the manual carrier picker).
  app.get('/api/hub/carriers', async (_req, reply) =>
    reply.send({
      carriers: CARRIERS.map((c) => ({ id: c.id, name: c.name, mode: c.mode })),
    }),
  );

  // GET /api/hub/detect?number= — recognise a number without storing it.
  app.get('/api/hub/detect', async (req, reply) => {
    const parsed = z.object({ number: z.string().trim().min(1).max(60) }).safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: 'number is required' });
    const det = detectNumber(parsed.data.number);
    return reply.send({
      normalized: det.normalized,
      candidates: det.candidates.map((c) => ({ ...c, carrierName: getCarrier(c.carrier)?.name ?? c.carrier })),
    });
  });

  // GET /api/hub/tracks[?workspaceId=&archived=1]
  app.get('/api/hub/tracks', async (req, reply) => {
    const q = z
      .object({ workspaceId: z.string().uuid().optional(), archived: z.string().optional() })
      .safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: 'Invalid query parameters' });
    const rows = await listTracked(req.user!.sub, {
      workspaceId: q.data.workspaceId,
      includeArchived: q.data.archived === '1',
    });
    return reply.send({ tracks: rows.map(serializeTracked) });
  });

  // POST /api/hub/tracks — add a number (checked immediately).
  app.post('/api/hub/tracks', async (req, reply) => {
    const body = addBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Вкажіть номер для відстеження.' });
    const userId = req.user!.sub;
    if (body.data.workspaceId && !(await getOwnedWorkspace(userId, body.data.workspaceId))) {
      return reply.status(404).send({ error: 'Workspace not found' });
    }
    try {
      const row = await addTracked(userId, body.data);
      return reply.status(201).send({ track: serializeTracked(row), events: await listEvents(row.id) });
    } catch (err) {
      return sendHubError(reply, err);
    }
  });

  // GET /api/hub/tracks/:id — item + events timeline.
  app.get('/api/hub/tracks/:id', async (req, reply) => {
    const p = idParams.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: 'Not found' });
    const row = await getTracked(req.user!.sub, p.data.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    return reply.send({ track: serializeTracked(row), events: await listEvents(row.id) });
  });

  // PATCH /api/hub/tracks/:id — rename / (un)link shipment / fix carrier / archive.
  app.patch('/api/hub/tracks/:id', async (req, reply) => {
    const p = idParams.safeParse(req.params);
    const body = patchBody.safeParse(req.body);
    if (!p.success) return reply.status(404).send({ error: 'Not found' });
    if (!body.success) return reply.status(400).send({ error: 'Invalid body' });
    const userId = req.user!.sub;
    const row = await getTracked(userId, p.data.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    const b = body.data;
    if (b.workspaceId && !(await getOwnedWorkspace(userId, b.workspaceId))) {
      return reply.status(404).send({ error: 'Workspace not found' });
    }
    if (b.carrier && !getCarrier(b.carrier)) return reply.status(400).send({ error: 'Невідомий перевізник.' });
    const carrier = b.carrier ? getCarrier(b.carrier)! : null;
    await query(
      `UPDATE tracked_items SET
         label = COALESCE($2, label),
         workspace_id = CASE WHEN $3 THEN $4::uuid ELSE workspace_id END,
         carrier = COALESCE($5, carrier),
         mode = COALESCE($6, mode),
         archived = COALESCE($7, archived),
         page_hash = CASE WHEN $5 IS NOT NULL THEN '' ELSE page_hash END
       WHERE id = $1`,
      [
        row.id,
        b.label ?? null,
        b.workspaceId !== undefined,
        b.workspaceId ?? null,
        carrier?.id ?? null,
        carrier?.mode ?? null,
        b.archived ?? null,
      ],
    );
    if (carrier) await refreshTracked(row.id);
    const fresh = await getTracked(userId, row.id);
    return reply.send({ track: serializeTracked(fresh!), events: await listEvents(row.id) });
  });

  // DELETE /api/hub/tracks/:id — only the user who added it can delete.
  app.delete('/api/hub/tracks/:id', async (req, reply) => {
    const p = idParams.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: 'Not found' });
    const { rowCount } = await query('DELETE FROM tracked_items WHERE id = $1 AND owner_id = $2', [
      p.data.id,
      req.user!.sub,
    ]);
    if (!rowCount) return reply.status(404).send({ error: 'Not found' });
    return reply.status(204).send();
  });

  // POST /api/hub/tracks/:id/refresh — manual re-check (throttled).
  app.post('/api/hub/tracks/:id/refresh', async (req, reply) => {
    const p = idParams.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: 'Not found' });
    const row = await getTracked(req.user!.sub, p.data.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    const last = row.last_checked_at ? new Date(row.last_checked_at).getTime() : 0;
    if (Date.now() - last < MANUAL_REFRESH_MIN_MS) {
      return reply.status(429).send({ error: 'Щойно перевіряли — спробуйте за кілька хвилин.' });
    }
    await refreshTracked(row.id);
    const fresh = await getTracked(req.user!.sub, row.id);
    return reply.send({ track: serializeTracked(fresh!), events: await listEvents(row.id) });
  });

  // GET /api/hub/live — everything the live map draws (items + ambient AIS).
  app.get('/api/hub/live', async (req, reply) => reply.send(await liveSnapshot(req.user!.sub)));

  // ── Phase 2: ports / airports / crossings ────────────────────────────────

  const codeParams = z.object({ code: z.string().trim().min(3).max(8) });

  // GET /api/hub/ports — atlas with current status, my favourites, my tracks heading there.
  app.get('/api/hub/ports', async (req, reply) => reply.send({ ports: await listPorts(req.user!.sub) }));

  // GET /api/hub/ports/:code — status, mark history, my tracks to this place.
  app.get('/api/hub/ports/:code', async (req, reply) => {
    const p = codeParams.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: 'Not found' });
    const port = await getPort(req.user!.sub, p.data.code);
    if (!port) return reply.status(404).send({ error: 'Not found' });
    return reply.send(port);
  });

  // POST /api/hub/ports/:code/status — a logist marks the status (team-wide, 72 h).
  app.post('/api/hub/ports/:code/status', async (req, reply) => {
    const p = codeParams.safeParse(req.params);
    const body = z
      .object({ status: z.enum(PORT_STATUSES as [string, ...string[]]), note: z.string().trim().max(500).optional() })
      .safeParse(req.body);
    if (!p.success) return reply.status(404).send({ error: 'Not found' });
    if (!body.success) return reply.status(400).send({ error: 'Оберіть статус.' });
    const ok = await addMark({
      code: p.data.code,
      status: body.data.status as (typeof PORT_STATUSES)[number],
      note: body.data.note,
      source: 'user',
      userId: req.user!.sub,
    });
    if (!ok) return reply.status(404).send({ error: 'Not found' });
    return reply.send(await getPort(req.user!.sub, p.data.code));
  });

  // POST /api/hub/ports/:code/status/:markId/confirm — confirm the current (AI) mark.
  app.post('/api/hub/ports/:code/status/:markId/confirm', async (req, reply) => {
    const p = z.object({ code: z.string().min(3).max(8), markId: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: 'Not found' });
    const ok = await confirmMark(req.user!.sub, p.data.code, p.data.markId);
    if (!ok) return reply.status(404).send({ error: 'Позначка вже неактуальна.' });
    return reply.send(await getPort(req.user!.sub, p.data.code));
  });

  // PUT/DELETE /api/hub/ports/:code/favorite — personal ★.
  app.put('/api/hub/ports/:code/favorite', async (req, reply) => {
    const p = codeParams.safeParse(req.params);
    if (!p.success || !(await setFavorite(req.user!.sub, p.data.code, true))) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.status(204).send();
  });
  app.delete('/api/hub/ports/:code/favorite', async (req, reply) => {
    const p = codeParams.safeParse(req.params);
    if (!p.success || !(await setFavorite(req.user!.sub, p.data.code, false))) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.status(204).send();
  });

  // GET /api/workspaces/:id/tracking-suggestions — container / AWB / B/L numbers
  // found in the shipment's documents that are not tracked yet.
  app.get('/api/workspaces/:id/tracking-suggestions', async (req, reply) => {
    const p = idParams.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: 'Workspace not found' });
    const userId = req.user!.sub;
    if (!(await getOwnedWorkspace(userId, p.data.id))) return reply.status(404).send({ error: 'Workspace not found' });
    return reply.send({ suggestions: await trackingSuggestions(userId, p.data.id) });
  });
}
