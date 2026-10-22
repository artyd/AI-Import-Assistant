import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getOwnedCollection } from '../shipments/collectionAccess.js';
import {
  ensureConversationScoped,
  appendMessage,
  getConversationHistoryWithStats,
  listConversationsByCollection,
  getConversationMessagesByCollection,
} from './conversations.js';
import { SseStream } from '../lib/sse.js';
import { buildConsolidatedSystemPrompt } from '../agent/systemPrompt.js';
import { runAgentTurn } from '../agent/loop.js';
import { toolDefinitions, fclToolDefinitions, logistTools } from '../agent/tools.js';
import { hubToolDefinitions } from '../agent/tools/hub.js';
import { sheetTools } from '../agent/tools/sheet.js';
import { buildDocumentsDigest } from '../agent/documentsDigest.js';
import { listLots } from '../shipments/lots.js';
import { chatRateLimitConfig } from './chatRateLimit.js';

// A Збірник is an FCL workspace (spec 006): its chat gets every shipment tool
// (scoped to the FCL, with an optional lot), the FCL tools and the manifest
// analysis, plus the customs/logistics reference tools — one agent, more tools.
function consolidatedTools() {
  return [...toolDefinitions, ...fclToolDefinitions, ...logistTools(), ...hubToolDefinitions, ...sheetTools()];
}

const chatSchema = z.object({
  message: z.string().min(1).max(20_000),
  conversationId: z.string().uuid().optional(),
});

/**
 * The "consolidated" chat — Штурман scoped to a Збірник (FCL). Conversations are
 * collection-scoped; the loop's ToolContext carries the FCL as `workspaceId` (the
 * shipment tools) and as `collectionId` (the manifest analysis).
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
        const { history, stats: historyStats } = await getConversationHistoryWithStats(conversationId);
        await appendMessage(conversationId, 'user', message);

        const [documentsDigest, lots] = await Promise.all([
          buildDocumentsDigest(col.id).catch(() => ''),
          listLots(col.id),
        ]);
        const result = await runAgentTurn({
          system: buildConsolidatedSystemPrompt({
            number: col.number,
            lots: lots.map((l) => ({ name: l.name, supplier_name: l.supplier_name, status: l.status })),
            documentsDigest,
          }),
          history,
          userMessage: message,
          sse,
          signal: sse.signal,
          workspaceId: col.id,
          collectionId: col.id,
          ownerId: req.user!.sub,
          tools: consolidatedTools(),
        });

        // A failed save must not turn a streamed answer into an error: the user
        // still gets done + conversationId, so the next question stays in this chat.
        const messageId = await appendMessage(
          conversationId,
          'assistant',
          result.text,
          result.citations,
          result.toolCalls,
          result.turnBlocks,
          { ...result.usage, history: historyStats },
        ).catch((err: unknown) => {
          req.log.error({ err }, 'assistant message not persisted');
          return '';
        });

        if (result.error) {
          req.log.error({ err: result.error }, 'consolidated chat turn errored (partial persisted)');
          sse.send('error', { message: 'Відповідь перервалася. Спробуйте ще раз.' });
        } else {
          sse.send('done', {
            message: result.text,
            citations: result.citations,
            conversationId,
            messageId,
            usage: { ...result.usage, history: historyStats },
          });
        }
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
