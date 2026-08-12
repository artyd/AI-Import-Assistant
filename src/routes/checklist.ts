import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { refreshWorkspaceState } from '../services/status.js';

export async function checklistRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/workspaces/:id/checklist — deterministic completeness checklist.
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/checklist', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const { checklist, status } = await refreshWorkspaceState(ws);
    return reply.send({ items: checklist, status });
  });
}
