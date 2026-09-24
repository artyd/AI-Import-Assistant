import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getOwnedCollection } from '../services/collectionAccess.js';
import {
  ensureConversationScoped,
  appendMessage,
  getConversationHistory,
  listConversationsByCollection,
  getConversationMessagesByCollection,
} from '../services/conversations.js';
import { SseStream } from '../sse/sse.js';
import { buildConsolidatedSystemPrompt } from '../agent/systemPrompt.js';
import { runAgentTurn } from '../agent/loop.js';
import { toolDefinitions, logistTools } from '../agent/tools.js';
import { chatRateLimitConfig } from './chatRateLimit.js';

// Consolidated (Збірник) chats run with the manifest analysis engine plus the
// customs/logistics reference tools (УКТ ЗЕД / dual-use / НБУ / PubChem, when
// enabled). Shipment tools (checklist/discrepancies/…) are workspace-scoped and
// intentionally excluded here.
const analysisTool = toolDefinitions.filter((t) => t.name === 'run_consolidated_analysis');
function consolidatedTools() {
  return [...analysisTool, ...logistTools()];
}

const chatSchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().uuid().optional(),
});

/**
 * The "consolidated" chat — a consultant scoped to a Збірник (consolidated
 * cargo). Conversations are collection-scoped. The agent runs with a single tool,
 * `run_consolidated_analysis`, which analyses the collection's latest manifest
 * (CIF / мито / ПДВ per line, origin, EU/UA checks) and persists the result; the
 * loop is given a collection-scoped ToolContext (collectionId + ownerId).
 */
export async function chatConsolidatedRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/collections/:id/chat  (SSE)
  app.post<{ Params: { id: string } }>(
    '/api/collections/:id/chat',
    { config: chatRateLimitConfig },
    async (req, reply) => {
      const parsed = chatSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const col = await getOwnedCollection(req.user!.sub, req.params.id);
      if (!col) return reply.code(404).send({ error: 'not_found' });

      const { message, conversationId: incomingConvId } = parsed.data;

      // From here on we stream — take over the raw response.
      const sse = new SseStream(req, reply);
      const heartbeat = setInterval(() => sse.ping(), 15_000);

      try {
        const conversationId = await ensureConversationScoped(
          { kind: 'consolidated', collectionId: col.id },
          incomingConvId,
          message,
        );
        const history = await getConversationHistory(conversationId);
        await appendMessage(conversationId, 'user', message);

        const result = await runAgentTurn({
          system: buildConsolidatedSystemPrompt({ number: col.number }),
          history,
          userMessage: message,
          sse,
          collectionId: col.id,
          ownerId: req.user!.sub,
          tools: consolidatedTools(),
        });

        const messageId = await appendMessage(
          conversationId,
          'assistant',
          result.text,
          result.citations,
          result.toolCalls,
        );

        sse.send('done', {
          message: result.text,
          citations: result.citations,
          conversationId,
          messageId,
        });
      } catch (err) {
        req.log.error({ err }, 'consolidated chat turn failed');
        sse.send('error', { message: 'Не вдалося обробити запит. Спробуйте ще раз.' });
      } finally {
        clearInterval(heartbeat);
        sse.close();
      }
    },
  );

  // GET /api/collections/:id/conversations — list a collection's chats.
  app.get<{ Params: { id: string } }>(
    '/api/collections/:id/conversations',
    async (req, reply) => {
      const col = await getOwnedCollection(req.user!.sub, req.params.id);
      if (!col) return reply.code(404).send({ error: 'not_found' });
      const conversations = await listConversationsByCollection(col.id);
      return reply.send({ conversations });
    },
  );

  // GET /api/collections/:id/conversations/:convId — messages, collection-verified.
  app.get<{ Params: { id: string; convId: string } }>(
    '/api/collections/:id/conversations/:convId',
    async (req, reply) => {
      const col = await getOwnedCollection(req.user!.sub, req.params.id);
      if (!col) return reply.code(404).send({ error: 'not_found' });
      const messages = await getConversationMessagesByCollection(col.id, req.params.convId);
      if (messages === null) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ conversationId: req.params.convId, messages });
    },
  );
}
