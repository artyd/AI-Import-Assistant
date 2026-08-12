import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { computeDiscrepancies } from '../services/discrepancies.js';
import { saveArtifact } from '../services/artifacts.js';
import { compareFileVersions } from '../services/versions.js';

export async function discrepancyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/workspaces/:id/discrepancies — deterministic invoice/PO/PL reconciliation.
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/discrepancies',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const discrepancies = await computeDiscrepancies(ws.id);
      const { id: artifactId } = await saveArtifact(
        ws.id,
        'discrepancy_report',
        JSON.stringify(discrepancies, null, 2),
        'json',
        'agent',
      );
      return reply.send({ discrepancies, artifactId });
    },
  );

  // POST /api/workspaces/:id/compare-versions — field-level diff of two files'
  // structured extractions (typically a file and something in its version chain).
  const compareSchema = z.object({
    fileIdA: z.string().uuid(),
    fileIdB: z.string().uuid(),
  });
  app.post<{ Params: { id: string } }>(
    '/api/workspaces/:id/compare-versions',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const parsed = compareSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { fileIdA, fileIdB } = parsed.data;
      const result = await compareFileVersions(ws.id, fileIdA, fileIdB);
      if (!result) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ fileIdA, fileIdB, differences: result.differences });
    },
  );
}
