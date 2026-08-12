import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { buildAndSaveReport } from '../services/report.js';

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/workspaces/:id/report — generate + persist a self-contained HTML report.
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/report', async (req, reply) => {
    const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
    if (!ws) return reply.code(404).send({ error: 'not_found' });
    const { id, html } = await buildAndSaveReport(ws);
    return reply.send({ artifactId: id, html });
  });
}
