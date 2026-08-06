import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { getConversationMessages, listConversations } from '../services/conversations.js';

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

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
