import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { query } from '../db/pool.js';
import { getOwnedWorkspace } from '../shipments/workspaceAccess.js';
import {
  ensureConversation,
  appendMessage,
  rewindConversation,
  storedAnswer,
  getConversationHistoryWithStats,
} from './conversations.js';
import { SseStream } from '../lib/sse.js';
import { buildSystemPrompt } from '../agent/systemPrompt.js';
import { buildDocumentsDigest } from '../agent/documentsDigest.js';
import { runAgentTurn } from '../agent/loop.js';
import { toolDefinitions, logistTools } from '../agent/tools.js';
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

      const { message, conversationId: incomingConvId, replaceFrom } = parsed.data;

      // From here on we stream — take over the raw response.
      const sse = new SseStream(req, reply);
      const heartbeat = setInterval(() => sse.ping(), 15_000);

      try {
        const conversationId = await ensureConversation(ws.id, incomingConvId, message);
        if (replaceFrom && incomingConvId && !(await rewindConversation(conversationId, replaceFrom))) {
          sse.send('error', { message: 'Повідомлення для редагування не знайдено — надішліть питання ще раз.' });
          return;
        }
        const { history, stats: historyStats } = await getConversationHistoryWithStats(conversationId);
        const userMessageId = await appendMessage(conversationId, 'user', message);
        const documentsDigest = await buildDocumentsDigest(ws.id).catch(() => '');
        const { rows: parties } = await query<{ role: string; company_name: string }>(
          'SELECT role, company_name FROM parties WHERE workspace_id = $1 ORDER BY created_at',
          [ws.id],
        );
        const lessons = await lessonsBlockFor({ ownerId: req.user!.sub, chatKind: 'supply', workspaceId: ws.id });

        const result = await runAgentTurn({
          workspaceId: ws.id,
          ownerId: req.user!.sub,
          system: withLessons(
            buildSystemPrompt({
              number: ws.number,
              supplier: ws.supplier,
              contract_type: ws.contract_type,
              contract_type_source: ws.contract_type_source,
              contract_type_confidence: ws.contract_type_confidence,
              survey_status: ws.survey_status,
              parties,
              documentsDigest,
            }),
            lessons,
          ),
          history,
          userMessage: message,
          sse,
          signal: sse.signal,
          // Shipment tools + the customs/logistics reference tools (when enabled).
          tools: [...toolDefinitions, ...logistTools(), ...hubToolDefinitions, ...sheetTools(), ...supplyToolDefinitions],
        });

        // Persist the turn (partial text too, on error) with its replay blocks so
        // the next turn remembers what was read/extracted.
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
          req.log.error({ err: result.error }, 'chat turn errored (partial persisted)');
          alertChatFailure({ kind: 'supply', workspaceId: ws.id, aborted: sse.signal.aborted, message: result.error, anthropicHandled: result.anthropicOutage });
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
        req.log.error({ err }, 'chat turn failed');
        alertChatFailure({ kind: 'supply', workspaceId: ws.id, aborted: sse.signal.aborted, err });
        sse.send('error', { message: 'Не вдалося обробити запит. Спробуйте ще раз.' });
      } finally {
        clearInterval(heartbeat);
        sse.close();
      }
    },
  );
}
