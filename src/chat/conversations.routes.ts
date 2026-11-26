import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { query } from '../db/pool.js';
import { getOwnedWorkspace } from '../shipments/workspaceAccess.js';
import { getConversationMessages, listConversations } from './conversations.js';

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // DELETE /api/conversations/:convId — any chat kind, only if the user owns it:
  // a normal chat by owner_id, a supply / consolidated chat through its shipment
  // or Збірник. Messages go with it (ON DELETE CASCADE). 404 when not owned.
  app.delete<{ Params: { convId: string } }>('/api/conversations/:convId', async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.convId);
    if (!id.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rowCount } = await query(
      `DELETE FROM conversations
        WHERE id = $1
          AND (owner_id = $2
               OR workspace_id IN (SELECT id FROM workspaces WHERE owner_id = $2)
               OR collection_id IN (SELECT id FROM workspaces WHERE owner_id = $2))`,
      [id.data, req.user!.sub],
    );
    return rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });

  // GET /api/workspaces/:id/conversations
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/conversations',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const conversations = await listConversations(ws.id);
      return reply.send({ conversations });
    },
  );

  // GET /api/workspaces/:id/conversations/:convId
  app.get<{ Params: { id: string; convId: string } }>(
    '/api/workspaces/:id/conversations/:convId',
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      const messages = await getConversationMessages(ws.id, req.params.convId);
      if (messages === null) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ conversationId: req.params.convId, messages });
    },
  );
}
