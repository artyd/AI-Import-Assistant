import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { upsertParties, validateParties, listParties } from '../services/parties.js';

const partySchema = z.object({
  role: z.enum(['our_company', 'supplier', 'intermediary']),
  company_name: z.string().min(1),
  is_internal: z.boolean().optional(),
  country: z.string().nullable().optional(),
  contact_info: z.record(z.unknown()).optional(),
});
const bulkSchema = z.object({ parties: z.array(partySchema) });

export async function partiesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/workspaces/:id/parties
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/parties', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ parties: await listParties(ws.id) });
  });

  // POST /api/workspaces/:id/parties — bulk upsert (replace), with soft warnings.
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/parties', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const warnings = validateParties(ws.contract_type, parsed.data.parties);
    const parties = await upsertParties(ws.id, parsed.data.parties);
    return reply.send({ parties, warnings });
  });
}
