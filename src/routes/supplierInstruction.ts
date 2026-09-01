import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import {
  buildSupplierInstruction,
  INSTRUCTION_SECTIONS,
  type InstructionSection,
} from '../services/supplierInstruction.js';

const bodySchema = z.object({
  // Optional subset of letter sections (the constructor UI). Omit for all.
  sections: z.array(z.enum(INSTRUCTION_SECTIONS)).optional(),
});

export async function supplierInstructionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/workspaces/:id/supplier-instruction — generate & persist a letter.
  app.post<{ Params: { id: string } }>(
    '/api/workspaces/:id/supplier-instruction',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });

      const parsed = bodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }

      const result = await buildSupplierInstruction(ws, {
        sections: parsed.data.sections as InstructionSection[] | undefined,
      });
      if ('missing' in result) {
        return reply.code(400).send({ error: 'missing_context', missing: result.missing });
      }
      return reply.send({ instruction: result.instruction, artifactId: result.artifactId });
    },
  );
}
