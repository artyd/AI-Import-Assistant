import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { streamWorkspaceZip } from '../services/export.js';

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/workspaces/:id/export — streams a zip archive of the workspace.
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/export', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    await streamWorkspaceZip(ws, reply);
    return reply;
  });
}
