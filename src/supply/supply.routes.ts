import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { codeLoginEnabled, codeMatches } from '../auth/accessCode.js';
import { codeLoginRateLimit, isCodeLoginLocked, recordCodeFailure } from '../auth/loginThrottle.js';
import { config } from '../lib/config.js';
import { requireSupplyEditor, signSupplyToken, supplyEditor } from './access.js';
import { buildSupplyXlsx } from './export.js';
import {
  SupplyConflict,
  SupplyNotFound,
  SupplyNotUndoable,
  createShipment,
  getSettings,
  listHistory,
  listShipments,
  putSettings,
  revision,
  setArchived,
  setMarks,
  undoHistory,
  updateShipment,
} from './store.js';
import { archiveSchema, marksSchema, settingsSchema, shipmentInputSchema, shipmentPatchSchema } from './types.js';

const idParam = z.object({ id: z.string().uuid() });
const historyParam = z.object({ id: z.coerce.number().int().positive() });
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), shipmentId: z.string().uuid().optional() });
const codeSchema = z.object({ code: z.string().min(1).max(32) });

function storeError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof SupplyConflict) return reply.code(409).send({ error: 'conflict', current: err.current });
  if (err instanceof SupplyNotFound) return reply.code(404).send({ error: 'not_found' });
  if (err instanceof SupplyNotUndoable) return reply.code(409).send({ error: 'not_undoable' });
  throw err;
}

/**
 * Поставки (spec 008). A separate app: reads are public (no Штурман data here),
 * writes need the Штурман PIN (supply token) or a Штурман session.
 */
export async function supplyRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/supply — the whole register: shipments (incl. archived) + dictionaries.
  app.get('/api/supply', async (req, reply) => {
    const [shipments, settings, rev] = await Promise.all([listShipments(), getSettings(), revision()]);
    return reply.header('Cache-Control', 'no-store').send({ shipments, settings, revision: rev, canEdit: supplyEditor(req) !== null });
  });

  // GET /api/supply/revision — cheap poll target for the 30 s auto-refresh.
  app.get('/api/supply/revision', async (_req, reply) => {
    return reply.header('Cache-Control', 'no-store').send({ revision: await revision() });
  });

  // GET /api/supply/history?limit=&shipmentId=
  app.get('/api/supply/history', async (req, reply) => {
    const q = historyQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    return reply.send({ history: await listHistory(q.data.limit, q.data.shipmentId) });
  });

  // GET /api/supply/export.xlsx
  app.get('/api/supply/export.xlsx', async (_req, reply) => {
    const [shipments, settings] = await Promise.all([listShipments(), getSettings()]);
    const buf = buildSupplyXlsx(shipments, settings);
    const name = `postavky-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(buf);
  });

  // GET /api/supply/session — does the caller's token allow editing?
  app.get('/api/supply/session', async (req, reply) => {
    return reply.send({ canEdit: supplyEditor(req) !== null, codeLogin: codeLoginEnabled(), codeLength: codeLoginEnabled() ? config.ACCESS_CODE.length : null });
  });

  // POST /api/supply/unlock { code } — the Штурман PIN unlocks editing here only.
  // Same throttles as the Штурман PIN login (per IP + global lockout).
  app.post('/api/supply/unlock', { config: { rateLimit: codeLoginRateLimit } }, async (req, reply) => {
    if (!codeLoginEnabled()) return reply.code(404).send({ error: 'code_login_disabled' });
    if (isCodeLoginLocked(config.ACCESS_CODE_MAX_FAILURES)) return reply.code(429).send({ error: 'code_login_locked' });
    const parsed = codeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!codeMatches(parsed.data.code)) {
      recordCodeFailure();
      return reply.code(401).send({ error: 'invalid_code' });
    }
    return reply.send(signSupplyToken());
  });

  // ── writes ──
  app.post('/api/supply/shipments', { preHandler: requireSupplyEditor }, async (req, reply) => {
    const body = shipmentInputSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    return reply.code(201).send({ shipment: await createShipment(body.data, req.supplyActor!) });
  });

  app.patch('/api/supply/shipments/:id', { preHandler: requireSupplyEditor }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const body = shipmentPatchSchema.safeParse(req.body);
    if (!p.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return reply.send({ shipment: await updateShipment(p.data.id, body.data, req.supplyActor!) });
    } catch (err) {
      return storeError(reply, err);
    }
  });

  app.post('/api/supply/shipments/:id/archive', { preHandler: requireSupplyEditor }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const body = archiveSchema.safeParse(req.body);
    if (!p.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return reply.send({ shipment: await setArchived(p.data.id, body.data.archived, req.supplyActor!) });
    } catch (err) {
      return storeError(reply, err);
    }
  });

  // PATCH /api/supply/shipments/:id/marks { pinned?, groups?, mode? } — star, groups, transport.
  app.patch('/api/supply/shipments/:id/marks', { preHandler: requireSupplyEditor }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const body = marksSchema.safeParse(req.body);
    if (!p.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return reply.send({ shipment: await setMarks(p.data.id, body.data, req.supplyActor!) });
    } catch (err) {
      return storeError(reply, err);
    }
  });

  app.post('/api/supply/settings', { preHandler: requireSupplyEditor }, async (req, reply) => {
    const body = settingsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    return reply.send({ settings: await putSettings(body.data, req.supplyActor!) });
  });

  app.post('/api/supply/history/:id/undo', { preHandler: requireSupplyEditor }, async (req, reply) => {
    const p = historyParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      await undoHistory(p.data.id, req.supplyActor!);
      return reply.send({ ok: true });
    } catch (err) {
      return storeError(reply, err);
    }
  });
}
