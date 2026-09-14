import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import {
  ensureConversation,
  appendMessage,
  getConversationHistory,
} from '../services/conversations.js';
import { SseStream } from '../sse/sse.js';
import { buildSystemPrompt } from '../agent/systemPrompt.js';
import { runAgentTurn } from '../agent/loop.js';
import { chatRateLimitConfig } from './chatRateLimit.js';

const chatSchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().uuid().optional(),
});

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/workspaces/:id/chat  (SSE)
  // Per-user rate limit to bound Anthropic cost from runaway usage.
  app.post<{ Params: { id: string } }>(
    '/api/workspaces/:id/chat',
    { config: chatRateLimitConfig },
    async (req, reply) => {
      const parsed = chatSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });

      const { message, conversationId: incomingConvId } = parsed.data;

      // From here on we stream — take over the raw response.
      const sse = new SseStream(req, reply);
      const heartbeat = setInterval(() => sse.ping(), 15_000);

      try {
        const conversationId = await ensureConversation(ws.id, incomingConvId, message);
        const history = await getConversationHistory(conversationId);
        await appendMessage(conversationId, 'user', message);

        const result = await runAgentTurn({
          workspaceId: ws.id,
          system: buildSystemPrompt({ number: ws.number, supplier: ws.supplier }),
          history,
          userMessage: message,
          sse,
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
        req.log.error({ err }, 'chat turn failed');
        sse.send('error', { message: 'Не вдалося обробити запит. Спробуйте ще раз.' });
      } finally {
        clearInterval(heartbeat);
        sse.close();
      }
    },
  );
}
