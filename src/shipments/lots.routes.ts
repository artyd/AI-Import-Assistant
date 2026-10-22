import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query } from '../db/pool.js';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace, type WorkspaceRow } from './workspaceAccess.js';
import { ensureLot, getLot, type LotRow } from './lots.js';
import { lotFolderName } from './folders.js';
import { flattenFcl, loadFclVerdicts, type LotVerdict } from './fclState.js';
import { shipmentChanged } from './state.js';
import { listParties, upsertParties, validateParties } from '../reconciliation/parties.js';

/**
 * Lots and the FCL overview of a Збірник (spec 006 #06). Every route loads the
 * workspace through getOwnedWorkspace and 404s unless it is an FCL; writes end
 * with shipmentChanged.
 */

async function ownedFcl(userId: string, id: string): Promise<WorkspaceRow | null> {
  const ws = await getOwnedWorkspace(userId, id);
  return ws && ws.kind === 'fcl' ? ws : null;
}

function lotContext(lot: LotRow) {
  return {
    consignee: lot.consignee,
    incoterm_in: lot.incoterm_in,
    incoterm_out: lot.incoterm_out,
    product_category: lot.product_category,
    origin_country: lot.origin_country,
    contract_type: lot.contract_type,
    contract_type_source: lot.contract_type_source,
    contract_type_reason: lot.contract_type_reason,
    auto_fields: lot.auto_fields,
  };
}

/** The row of the «Партії» table: traffic lights of one lot. */
function lotSummary(v: LotVerdict) {
  const { checklist, discrepancies, risks } = v.verdicts;
  return {
    id: v.lot.id,
    name: v.lot.name,
    supplier_name: v.lot.supplier_name,
    source: v.lot.source,
    status: v.lot.status,
    derived_status: v.verdicts.derivedStatus,
    file_count: v.fileCount,
    consignee: v.consignee,
    intake_complete: v.intakeComplete,
    completeness: { done: checklist.filter((i) => i.status !== 'missing').length, total: checklist.length },
    discrepancies: {
      confirmed: discrepancies.filter((d) => d.kind === 'confirmed').length,
      suspected: discrepancies.filter((d) => d.kind !== 'confirmed').length,
    },
    risks: {
      error: risks.filter((r) => r.severity === 'error').length,
      warning: risks.filter((r) => r.severity === 'warning').length,
    },
    context: lotContext(v.lot),
  };
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  supplier_name: z.string().trim().max(200).optional(),
});

const LOT_CONTEXT_FIELDS = ['incoterm_in', 'incoterm_out', 'origin_country', 'contract_type'] as const;
const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  supplier_name: z.string().trim().max(200).optional(),
  consignee: z.string().trim().max(200).nullable().optional(),
  incoterm_in: z.string().trim().max(10).nullable().optional(),
  incoterm_out: z.string().trim().max(10).nullable().optional(),
  product_category: z.string().trim().max(60).nullable().optional(),
  origin_country: z.string().trim().max(80).nullable().optional(),
  contract_type: z.enum(['bilateral', 'trilateral']).nullable().optional(),
});

const fclPatchSchema = z.object({ eu_transit: z.boolean().nullable() });

const partySchema = z.object({
  role: z.string().min(1),
  company_name: z.string().min(1),
  is_internal: z.boolean().optional(),
  country: z.string().nullable().optional(),
  contact_info: z.record(z.unknown()).optional(),
});
const partiesSchema = z.object({ parties: z.array(partySchema) });

export async function lotRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/workspaces/:id/fcl — the whole-FCL overview.
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/fcl', async (req, reply) => {
    const ws = await ownedFcl(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const v = await loadFclVerdicts(ws);
    const { discrepancies, risks } = flattenFcl(v);
    return reply.send({
      fcl: {
        id: ws.id,
        number: ws.number,
        status: ws.status,
        derived_status: v.level.derivedStatus,
        level_status: v.level.levelStatus,
        intake_complete: ws.intake_complete,
        transport_mode: ws.transport_mode,
        product_category: ws.product_category,
        destination_country: ws.destination_country,
        eu_transit: ws.eu_transit,
        eu_transit_derived: v.level.euTransit,
        containers: v.level.containers,
        unassigned: v.level.unassigned,
      },
      checklist: v.level.checklist,
      discrepancies: v.level.discrepancies,
      consignees: v.level.consignees,
      manifest: v.level.manifest,
      hbl_lot: v.level.hblLot,
      risks,
      all_discrepancies: discrepancies,
      lots: v.lots.map(lotSummary),
    });
  });

  // PATCH /api/workspaces/:id/fcl — FCL-only context (EU transit).
  app.patch<{ Params: { id: string } }>('/api/workspaces/:id/fcl', async (req, reply) => {
    const ws = await ownedFcl(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = fclPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    await query('UPDATE workspaces SET eu_transit = $2 WHERE id = $1', [ws.id, parsed.data.eu_transit]);
    const res = await shipmentChanged(ws.id, 'context');
    return reply.send({ ok: true, status: res?.workspace.status ?? ws.status });
  });

  // GET /api/workspaces/:id/lots — the «Партії» table.
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/lots', async (req, reply) => {
    const ws = await ownedFcl(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const v = await loadFclVerdicts(ws);
    return reply.send({ lots: v.lots.map(lotSummary), unassigned: v.level.unassigned });
  });

  // GET /api/workspaces/:id/lots/:lotId — one lot's verdicts (like a shipment's).
  app.get<{ Params: { id: string; lotId: string } }>('/api/workspaces/:id/lots/:lotId', async (req, reply) => {
    const ws = await ownedFcl(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const v = await loadFclVerdicts(ws);
    const lot = v.lots.find((l) => l.lot.id === req.params.lotId);
    if (!lot) return reply.code(404).send({ error: 'not_found' });
    return reply.send({
      lot: lotSummary(lot),
      checklist: lot.verdicts.checklist,
      discrepancies: lot.verdicts.discrepancies,
      risks: lot.verdicts.risks,
      parties: await listParties(ws.id, lot.lot.id),
    });
  });

  // POST /api/workspaces/:id/lots — a lot by hand (+ its folder).
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/lots', async (req, reply) => {
    const ws = await ownedFcl(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    const { lot, folderId, created } = await ensureLot(ws.id, parsed.data.supplier_name ?? '', 'manual', parsed.data.name);
    if (created) await shipmentChanged(ws.id, 'files');
    return reply.code(created ? 201 : 200).send({ lot, folderId, created });
  });

  // PATCH /api/workspaces/:id/lots/:lotId — name, consignee, lot context.
  app.patch<{ Params: { id: string; lotId: string } }>('/api/workspaces/:id/lots/:lotId', async (req, reply) => {
    const ws = await ownedFcl(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const lot = await getLot(ws.id, req.params.lotId);
    if (!lot) return reply.code(404).send({ error: 'not_found' });
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

    const sets: string[] = [];
    const vals: unknown[] = [lot.id];
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      sets.push(`${key} = $${vals.length + 1}`); // whitelisted by the zod schema
      vals.push(value);
    }
    // A human value: the autopilot must never overwrite it (manual:<field> marker).
    const manual = LOT_CONTEXT_FIELDS.filter((f) => parsed.data[f] !== undefined);
    if (manual.length > 0) {
      const p = vals.length + 1;
      sets.push(
        `auto_fields = ARRAY(SELECT DISTINCT x FROM unnest(auto_fields || $${p + 1}::text[]) x WHERE x <> ALL($${p}::text[]))`,
      );
      vals.push(manual, manual.map((f) => `manual:${f}`));
    }
    if (parsed.data.contract_type !== undefined) sets.push(`contract_type_source = 'sidebar'`);
    if (sets.length === 0) return reply.send({ lot });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE lots SET ${sets.join(', ')} WHERE id = $1`, vals);
      if (parsed.data.name) {
        await client.query('UPDATE folders SET name = $2 WHERE lot_id = $1', [lot.id, lotFolderName(parsed.data.name)]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await shipmentChanged(ws.id, 'context');
    return reply.send({ lot: await getLot(ws.id, lot.id) });
  });

  // DELETE /api/workspaces/:id/lots/:lotId — its files go back to the inbox.
  app.delete<{ Params: { id: string; lotId: string } }>('/api/workspaces/:id/lots/:lotId', async (req, reply) => {
    const ws = await ownedFcl(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const lot = await getLot(ws.id, req.params.lotId);
    if (!lot) return reply.code(404).send({ error: 'not_found' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE files SET folder_id = NULL WHERE workspace_id = $1 AND folder_id IN (SELECT id FROM folders WHERE lot_id = $2)',
        [ws.id, lot.id],
      );
      await client.query('DELETE FROM lots WHERE id = $1', [lot.id]); // cascades its folder, parties, checklist
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await shipmentChanged(ws.id, 'files');
    return reply.send({ ok: true });
  });

  // POST /api/workspaces/:id/lots/:lotId/parties — the lot's Хто / Через кого / Кому.
  app.post<{ Params: { id: string; lotId: string } }>('/api/workspaces/:id/lots/:lotId/parties', async (req, reply) => {
    const ws = await ownedFcl(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const lot = await getLot(ws.id, req.params.lotId);
    if (!lot) return reply.code(404).send({ error: 'not_found' });
    const parsed = partiesSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    const warnings = validateParties(lot.contract_type, parsed.data.parties);
    const parties = await upsertParties(ws.id, parsed.data.parties, { lotId: lot.id });
    await shipmentChanged(ws.id, 'parties');
    return reply.send({ parties, warnings });
  });
}
