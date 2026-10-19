import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../shipments/workspaceAccess.js';
import { shipmentVerdicts } from './verdicts.js';

export async function riskRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/workspaces/:id/risks — proactive current + upcoming problems
  // (expiry, missing docs, discrepancies, delivery deadlines).
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/risks', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const { risks } = await shipmentVerdicts(ws);
    return reply.send({ risks });
  });
}
