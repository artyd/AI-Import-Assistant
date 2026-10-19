import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query } from '../db/pool.js';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace, WORKSPACE_STATUSES } from './workspaceAccess.js';
import { FOLDER_SKELETON } from './folders.js';
import { shipmentChanged } from './state.js';
import { deleteWorkspaceStorage } from '../lib/storage.js';
import { writeManualContext } from './autoContext.js';
import { proposePartyFieldsForMode, realignPartiesForMode } from '../instruction/realign.js';

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

// Context columns: a PATCH touching any of them recomputes intake_complete.
const INTAKE_KEYS = [
  'contract_type',
  'product_category',
  'incoterm',
  'incoterm_in',
  'incoterm_out',
  'transport_mode',
  'origin_country',
  'destination_country',
] as const;

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
        incoterm_in: ws.incoterm_in,
        incoterm_out: ws.incoterm_out,
        transport_mode: ws.transport_mode,
        origin_country: ws.origin_country,
        destination_country: ws.destination_country,
        responsible_user_id: ws.responsible_user_id,
        contract_type_source: ws.contract_type_source,
        contract_type_confidence: ws.contract_type_confidence,
        contract_type_reason: ws.contract_type_reason,
        survey_status: ws.survey_status,
        survey_answers: ws.survey_answers,
      },
      folders,
    });
  });

  // DELETE /api/workspaces/:id — remove a shipment and everything it owns.
  // The DB cascade (folders, files, conversations/messages, extractions,
  // checklist, parties, notifications, artifacts) handles relational rows; we
  // additionally purge the workspace's on-disk files.
  app.delete<{ Params: { id: string } }>('/api/workspaces/:id', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    await deleteWorkspaceStorage(ws.id);
    await query('DELETE FROM workspaces WHERE id = $1', [ws.id]);
    return reply.send({ ok: true });
  });

  // POST /api/workspaces/:id/duplicate — clone a shipment's context (intake
  // scalars + a fresh folder skeleton + parties), WITHOUT copying files,
  // conversations, extractions, checklist items, or artifacts.
  app.post<{ Params: { id: string } }>(
    '/api/workspaces/:id/duplicate',
    async (req, reply) => {
      const src = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!src) return reply.code(404).send({ error: 'not_found' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const number = `${src.number ?? defaultNumber()}-копія`;
        const { rows } = await client.query(
          `INSERT INTO workspaces
             (owner_id, number, supplier, status, contract_type, intake_complete,
              product_category, incoterm, incoterm_in, incoterm_out, transport_mode,
              origin_country, destination_country,
              contract_type_source, contract_type_confidence, contract_type_reason)
           VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING id`,
          [
            req.user!.sub,
            number,
            src.supplier,
            src.contract_type,
            src.intake_complete,
            src.product_category,
            src.incoterm,
            src.incoterm_in,
            src.incoterm_out,
            src.transport_mode,
            src.origin_country,
            src.destination_country,
            // Carry the contract-mode provenance so the clone keeps its override
            // lock; survey state is intentionally NOT copied (fresh shipment).
            src.contract_type_source,
            src.contract_type_confidence,
            src.contract_type_reason,
          ],
        );
        const newId = rows[0].id as string;

        // Fresh folder skeleton.
        for (let i = 0; i < FOLDER_SKELETON.length; i++) {
          await client.query(
            'INSERT INTO folders (workspace_id, name, position) VALUES ($1, $2, $3)',
            [newId, FOLDER_SKELETON[i], i],
          );
        }

        // Copy parties (contract context, not documents). Drop to blank copy by
        // removing this INSERT…SELECT if a truly empty duplicate is preferred.
        await client.query(
          `INSERT INTO parties (workspace_id, role, company_name, is_internal, country, contact_info)
           SELECT $1, role, company_name, is_internal, country, contact_info
           FROM parties WHERE workspace_id = $2`,
          [newId, src.id],
        );

        await client.query('COMMIT');

        // The copy carries the source's context and parties: compute its verdicts.
        await shipmentChanged(newId, 'context', { keepIntakeFlag: true });
        const workspace = (await getOwnedWorkspace(req.user!.sub, newId))!;
        return reply.code(201).send({ workspace });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // PATCH /api/workspaces/:id — update intake / contract fields. Flipping
  // intake_complete to true (re)computes the checklist and derived status.
  const patchSchema = z.object({
    number: z.string().min(1).optional(),
    supplier: z.string().optional(),
    contract_type: z.enum(['bilateral', 'trilateral']).nullable().optional(),
    product_category: z.string().nullable().optional(),
    incoterm: z.string().nullable().optional(),
    incoterm_in: z.string().nullable().optional(),
    incoterm_out: z.string().nullable().optional(),
    transport_mode: z.string().nullable().optional(),
    origin_country: z.string().nullable().optional(),
    destination_country: z.string().nullable().optional(),
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
    await writeManualContext(ws, parsed.data, { by: 'sidebar' });
    // A mode the user picked by hand also realigns the parties card and proposes
    // the matching consignor/consignee in an open instruction draft.
    const mode = parsed.data.contract_type;
    if (mode && mode !== ws.contract_type) {
      await realignPartiesForMode(ws.id, mode);
      await proposePartyFieldsForMode(ws.id, mode);
    }

    // intake_complete is recomputed only when context changed and the caller
    // did not set it explicitly.
    const touchesContext = INTAKE_KEYS.some((k) => parsed.data[k] !== undefined);
    const state = (await shipmentChanged(ws.id, 'context', {
      keepIntakeFlag: parsed.data.intake_complete !== undefined || !touchesContext,
    }))!;
    if (state.workspace.intake_complete) {
      return reply.send({ workspace: state.workspace, checklist: state.checklist });
    }
    return reply.send({ workspace: state.workspace });
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
    incoterm_in: z.string().nullable().optional(),
    incoterm_out: z.string().nullable().optional(),
    transport_mode: z.string().nullable().optional(),
    origin_country: z.string().nullable().optional(),
    // destination_country is settable here but intentionally NOT part of the
    // intake_complete required-five derivation below (see decision in the audit).
    destination_country: z.string().nullable().optional(),
  });
  app.patch<{ Params: { id: string } }>('/api/workspaces/:id/intake', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = intakeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    await writeManualContext(ws, parsed.data, { by: 'sidebar' });

    // intake_complete is recomputed from the required five fields.
    const state = (await shipmentChanged(ws.id, 'context'))!;
    if (state.workspace.intake_complete) {
      return reply.send({ workspace: state.workspace, checklist: state.checklist });
    }
    return reply.send({ workspace: state.workspace });
  });

  // PATCH /api/workspaces/:id/survey — persist the shipment-survey state (answers
  // JSONB + status) for resumability. User data — never auto-mutated. Does NOT
  // touch contract_type: the mode is set through the chat (set_contract_mode) so
  // its provenance lock stays authoritative.
  const surveySchema = z.object({
    answers: z.record(z.object({ question: z.string(), answer: z.string() })).optional(),
    status: z.enum(['not_started', 'in_progress', 'completed', 'skipped']).optional(),
  });
  app.patch<{ Params: { id: string } }>('/api/workspaces/:id/survey', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = surveySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const sets: string[] = [];
    const vals: unknown[] = [ws.id];
    if (parsed.data.answers !== undefined) {
      sets.push(`survey_answers = $${vals.length + 1}::jsonb`);
      vals.push(JSON.stringify(parsed.data.answers));
    }
    if (parsed.data.status !== undefined) {
      sets.push(`survey_status = $${vals.length + 1}`);
      vals.push(parsed.data.status);
    }
    if (sets.length > 0) {
      await query(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = $1`, vals);
    }
    const updated = (await getOwnedWorkspace(req.user!.sub, req.params.id))!;
    return reply.send({
      survey_status: updated.survey_status,
      survey_answers: updated.survey_answers,
    });
  });
}
