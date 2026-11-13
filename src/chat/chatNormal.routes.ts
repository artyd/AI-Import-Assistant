import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import {
  ensureConversationScoped,
  appendMessage,
  rewindConversation,
  storedAnswer,
  getConversationHistoryWithStats,
  listConversationsByOwner,
  getConversationMessagesByOwner,
} from './conversations.js';
import { SseStream } from '../lib/sse.js';
import { buildNormalSystemPrompt } from '../agent/systemPrompt.js';
import { runAgentTurn } from '../agent/loop.js';
import { logistTools } from '../agent/tools.js';
import { hubToolDefinitions } from '../agent/tools/hub.js';
import { sheetTools } from '../agent/tools/sheet.js';
import { supplyToolDefinitions } from '../agent/tools/supply.js';
import { chatRateLimitConfig } from './chatRateLimit.js';
import { alertChatFailure } from '../lib/alertHooks.js';
import { lessonsBlockFor } from '../feedback/store.js';
import { withLessons } from '../feedback/lesson.js';

const chatSchema = z.object({
  message: z.string().min(1).max(20_000),
  conversationId: z.string().uuid().optional(),
  // «Редагувати й надіслати знову»: the user message this one replaces (it and
  // everything after it are removed from the conversation first).
  replaceFrom: z.string().uuid().optional(),
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
    const { message, conversationId: incomingConvId, replaceFrom } = parsed.data;

    // From here on we stream — take over the raw response.
    const sse = new SseStream(req, reply);
    const heartbeat = setInterval(() => sse.ping(), 15_000);

    try {
      const conversationId = await ensureConversationScoped(
        { kind: 'normal', ownerId },
        incomingConvId,
        message,
      );
      if (replaceFrom && incomingConvId && !(await rewindConversation(conversationId, replaceFrom))) {
        sse.send('error', { message: 'Повідомлення для редагування не знайдено — надішліть питання ще раз.' });
        return;
      }
      const { history, stats: historyStats } = await getConversationHistoryWithStats(conversationId);
      const userMessageId = await appendMessage(conversationId, 'user', message);
      const lessons = await lessonsBlockFor({ ownerId, chatKind: 'normal', workspaceId: null });

      const result = await runAgentTurn({
        ownerId,
        // Plain string without lessons (cached by the loop as one block);
        // with lessons → [cached rules, lessons] so the cache entry is unchanged.
        system: withLessons(buildNormalSystemPrompt(), lessons),
        history,
        userMessage: message,
        sse,
        signal: sse.signal,
        // Global consultant: no shipment tools, but the customs/logistics
        // reference lookups (УКТ ЗЕД / dual-use / НБУ / PubChem) when enabled.
        tools: [
          ...logistTools(),
          ...hubToolDefinitions.filter((t) => 'name' in t && t.name !== 'find_tracking_numbers'),
          ...sheetTools(),
          ...supplyToolDefinitions,
        ],
      });

      // A failed save must not turn a streamed answer into an error: the user
      // still gets done + conversationId, so the next question stays in this chat.
      const messageId = await appendMessage(
        conversationId,
        'assistant',
        storedAnswer(result),
        result.citations,
        result.toolCalls,
        result.turnBlocks,
        { ...result.usage, history: historyStats },
      ).catch((err: unknown) => {
        req.log.error({ err }, 'assistant message not persisted');
        return '';
      });

      if (result.error) {
        req.log.error({ err: result.error }, 'normal chat turn errored (partial persisted)');
        alertChatFailure({ kind: 'normal', aborted: sse.signal.aborted, message: result.error, anthropicHandled: result.anthropicOutage });
        sse.send('error', { message: 'Відповідь перервалася. Спробуйте ще раз.' });
      } else {
        sse.send('done', {
          message: result.text,
          userMessageId,
          citations: result.citations,
          conversationId,
          messageId,
          usage: { ...result.usage, history: historyStats },
        });
      }
    } catch (err) {
      req.log.error({ err }, 'normal chat turn failed');
      alertChatFailure({ kind: 'normal', aborted: sse.signal.aborted, err });
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
