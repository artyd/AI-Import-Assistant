import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query } from '../db/pool.js';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace, WORKSPACE_STATUSES } from '../services/workspaceAccess.js';
import { FOLDER_SKELETON } from '../domain/folders.js';
import { refreshWorkspaceState } from '../services/status.js';
import { deleteWorkspaceChunks } from '../services/qdrant.js';
import { deleteWorkspaceStorage } from '../services/storage.js';

const createSchema = z.object({
  number: z.string().min(1).optional(),
  supplier: z.string().default(''),
  status: z.enum(['active', 'draft', 'done']).default('draft'),
});

function defaultNumber(): string {
  // Mirrors the prototype's "2026-####" scheme; the real UI can override.
  const year = new Date().getUTCFullYear();
  const seq = Math.floor(1000 + Math.random() * 8999);
  return `${year}-${seq}`;
}

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/workspaces — creates a workspace + the folder skeleton.
  app.post('/api/workspaces', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const { supplier, status } = parsed.data;
    const number = parsed.data.number ?? defaultNumber();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO workspaces (owner_id, number, supplier, status)
         VALUES ($1, $2, $3, $4) RETURNING id, number, supplier, status, created_at`,
        [req.user!.sub, number, supplier, status],
      );
      const ws = rows[0];
      for (let i = 0; i < FOLDER_SKELETON.length; i++) {
        await client.query(
          'INSERT INTO folders (workspace_id, name, position) VALUES ($1, $2, $3)',
          [ws.id, FOLDER_SKELETON[i], i],
        );
      }
      await client.query('COMMIT');
      return reply.code(201).send({ workspace: ws });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // GET /api/workspaces — list current user's workspaces.
  app.get('/api/workspaces', async (req, reply) => {
    const { rows } = await query(
      `SELECT id, number, supplier, status, created_at
       FROM workspaces WHERE owner_id = $1 ORDER BY created_at DESC`,
      [req.user!.sub],
    );
    return reply.send({ workspaces: rows });
  });

  // GET /api/workspaces/:id — workspace with folders.
  app.get<{ Params: { id: string } }>('/api/workspaces/:id', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const { rows: folders } = await query(
      'SELECT id, name, position FROM folders WHERE workspace_id = $1 ORDER BY position',
      [ws.id],
    );
    return reply.send({
      workspace: {
        id: ws.id,
        number: ws.number,
        supplier: ws.supplier,
        status: ws.status,
        created_at: ws.created_at,
        contract_type: ws.contract_type,
        intake_complete: ws.intake_complete,
        product_category: ws.product_category,
        incoterm: ws.incoterm,
        transport_mode: ws.transport_mode,
        origin_country: ws.origin_country,
        responsible_user_id: ws.responsible_user_id,
      },
      folders,
    });
  });

  // DELETE /api/workspaces/:id — remove a shipment and everything it owns.
  // The DB cascade (folders, files, conversations/messages, extractions,
  // checklist, parties, notifications, artifacts) handles relational rows; we
  // additionally purge the workspace's Qdrant vectors and on-disk files.
  app.delete<{ Params: { id: string } }>('/api/workspaces/:id', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    try {
      await deleteWorkspaceChunks(ws.id);
    } catch {
      // Vector store already clean / unreachable — don't block the delete.
    }
    await deleteWorkspaceStorage(ws.id);
    await query('DELETE FROM workspaces WHERE id = $1', [ws.id]);
    return reply.send({ ok: true });
  });

  // PATCH /api/workspaces/:id — update intake / contract fields. Flipping
  // intake_complete to true (re)computes the checklist and derived status.
  const patchSchema = z.object({
    number: z.string().min(1).optional(),
    supplier: z.string().optional(),
    contract_type: z.enum(['bilateral', 'trilateral']).nullable().optional(),
    product_category: z.string().nullable().optional(),
    incoterm: z.string().nullable().optional(),
    transport_mode: z.string().nullable().optional(),
    origin_country: z.string().nullable().optional(),
    responsible_user_id: z.string().uuid().nullable().optional(),
    intake_complete: z.boolean().optional(),
  });
  app.patch<{ Params: { id: string } }>('/api/workspaces/:id', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    // Validate a referenced responsible user actually exists.
    const rid = parsed.data.responsible_user_id;
    if (rid) {
      const { rows } = await query('SELECT 1 FROM users WHERE id = $1', [rid]);
      if (rows.length === 0) return reply.code(400).send({ error: 'invalid_user' });
    }

    // Whitelisted columns from the zod schema — safe to interpolate the names.
    const sets: string[] = [];
    const vals: unknown[] = [ws.id];
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      sets.push(`${key} = $${vals.length + 1}`);
      vals.push(value);
    }
    if (sets.length > 0) {
      await query(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = $1`, vals);
    }

    const updated = (await getOwnedWorkspace(req.user!.sub, req.params.id))!;
    // If intake is complete, refresh checklist + derived status.
    if (updated.intake_complete) {
      const state = await refreshWorkspaceState(updated);
      return reply.send({
        workspace: { ...updated, status: state.status },
        checklist: state.checklist,
      });
    }
    return reply.send({ workspace: updated });
  });

  // PATCH /api/workspaces/:id/status — manual status override.
  const statusSchema = z.object({
    status: z.enum(WORKSPACE_STATUSES as unknown as [string, ...string[]]),
  });
  app.patch<{ Params: { id: string } }>('/api/workspaces/:id/status', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const { rows } = await query(
      'UPDATE workspaces SET status = $2 WHERE id = $1 RETURNING id, number, supplier, status, created_at',
      [ws.id, parsed.data.status],
    );
    return reply.send({ workspace: rows[0] });
  });

  // PATCH /api/workspaces/:id/intake — sets contract/shipment context and
  // auto-flips intake_complete once all required fields are present.
  const intakeSchema = z.object({
    contract_type: z.enum(['bilateral', 'trilateral']).nullable().optional(),
    product_category: z.string().nullable().optional(),
    incoterm: z.string().nullable().optional(),
    transport_mode: z.string().nullable().optional(),
    origin_country: z.string().nullable().optional(),
  });
  app.patch<{ Params: { id: string } }>('/api/workspaces/:id/intake', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = intakeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    const sets: string[] = [];
    const vals: unknown[] = [ws.id];
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      sets.push(`${key} = $${vals.length + 1}`);
      vals.push(value);
    }
    if (sets.length > 0) {
      await query(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = $1`, vals);
    }

    // Recompute intake_complete from the required five fields.
    const merged = (await getOwnedWorkspace(req.user!.sub, req.params.id))!;
    const complete = Boolean(
      merged.contract_type &&
        merged.product_category &&
        merged.incoterm &&
        merged.transport_mode &&
        merged.origin_country,
    );
    if (complete !== merged.intake_complete) {
      await query('UPDATE workspaces SET intake_complete = $2 WHERE id = $1', [ws.id, complete]);
    }

    const updated = (await getOwnedWorkspace(req.user!.sub, req.params.id))!;
    if (updated.intake_complete) {
      const state = await refreshWorkspaceState(updated);
      return reply.send({ workspace: { ...updated, status: state.status }, checklist: state.checklist });
    }
    return reply.send({ workspace: updated });
  });
}
