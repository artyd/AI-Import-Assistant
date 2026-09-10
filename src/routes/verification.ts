import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import {
  getExtractionsForVerification,
  saveVerification,
} from '../services/verification.js';

/**
 * Human-in-the-loop extraction verification (plan Phase 1). The batch screen
 * reads GET .../extractions, and PATCH .../files/:fileId/extraction writes the
 * declarant's confirmed/corrected fields back before analysis is trusted.
 */
export async function verificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/workspaces/:id/extractions — all latest files' extractions +
  // which key fields still need human confirmation.
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/extractions',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const extractions = await getExtractionsForVerification(ws.id);
      return reply.send({ extractions });
    },
  );

  // PATCH /api/workspaces/:id/files/:fileId/extraction — save corrections.
  const saveSchema = z.object({
    fields: z.record(z.string(), z.unknown()).default({}),
    confirmed: z.array(z.string()).default([]),
  });
  app.patch<{ Params: { id: string; fileId: string } }>(
    '/api/workspaces/:id/files/:fileId/extraction',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const parsed = saveSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const ok = await saveVerification(ws.id, req.params.fileId, parsed.data);
      if (!ok) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ ok: true });
    },
  );
}
