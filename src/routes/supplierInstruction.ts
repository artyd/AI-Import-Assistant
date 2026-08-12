import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { buildSupplierInstruction } from '../services/supplierInstruction.js';

export async function supplierInstructionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/workspaces/:id/supplier-instruction — generate & persist a letter.
  app.post<{ Params: { id: string } }>(
    '/api/workspaces/:id/supplier-instruction',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });

      const result = await buildSupplierInstruction(ws);
      if ('missing' in result) {
        return reply.code(400).send({ error: 'missing_context', missing: result.missing });
      }
      return reply.send({ instruction: result.instruction, artifactId: result.artifactId });
    },
  );
}
