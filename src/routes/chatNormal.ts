import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import {
  ensureConversationScoped,
  appendMessage,
  getConversationHistory,
  listConversationsByOwner,
  getConversationMessagesByOwner,
} from '../services/conversations.js';
import { SseStream } from '../sse/sse.js';
import { buildNormalSystemPrompt } from '../agent/systemPrompt.js';
import { runAgentTurn } from '../agent/loop.js';
import { logistTools } from '../agent/tools.js';
import { chatRateLimitConfig } from './chatRateLimit.js';

const chatSchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().uuid().optional(),
});

/**
 * The GLOBAL "normal" chat — a general Ukrainian ЗЕД/customs consultant, not
 * scoped to any shipment or collection. Conversations are owner-scoped and the
 * agent runs with NO tools (answers from knowledge). Additive to the frozen
 * supply chat, which is untouched.
 */
export async function chatNormalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/chats  (SSE)
  app.post('/api/chats', { config: chatRateLimitConfig }, async (req, reply) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const ownerId = req.user!.sub;
    const { message, conversationId: incomingConvId } = parsed.data;

    // From here on we stream — take over the raw response.
    const sse = new SseStream(req, reply);
    const heartbeat = setInterval(() => sse.ping(), 15_000);

    try {
      const conversationId = await ensureConversationScoped(
        { kind: 'normal', ownerId },
        incomingConvId,
        message,
      );
      const history = await getConversationHistory(conversationId);
      await appendMessage(conversationId, 'user', message);

      const result = await runAgentTurn({
        system: buildNormalSystemPrompt(),
        history,
        userMessage: message,
        sse,
        // Global consultant: no shipment tools, but the customs/logistics
        // reference lookups (УКТ ЗЕД / dual-use / НБУ / PubChem) when enabled.
        tools: logistTools(),
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
      req.log.error({ err }, 'normal chat turn failed');
      sse.send('error', { message: 'Не вдалося обробити запит. Спробуйте ще раз.' });
    } finally {
      clearInterval(heartbeat);
      sse.close();
    }
  });

  // GET /api/chats — list the current user's normal conversations.
  app.get('/api/chats', async (req, reply) => {
    const conversations = await listConversationsByOwner(req.user!.sub);
    return reply.send({ conversations });
  });

  // GET /api/chats/:convId — messages of a normal conversation, owner-verified.
  app.get<{ Params: { convId: string } }>('/api/chats/:convId', async (req, reply) => {
    const messages = await getConversationMessagesByOwner(req.user!.sub, req.params.convId);
    if (messages === null) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ conversationId: req.params.convId, messages });
  });
}
