import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../shipments/workspaceAccess.js';
import { getOwnedCollection } from '../shipments/collectionAccess.js';
import { deriveLesson } from './derive.js';
import {
  deactivateLesson,
  getAssistantMessage,
  listFeedback,
  listLessons,
  saveLesson,
  upsertFeedback,
  type RatedMessage,
} from './store.js';

const idParams = z.object({ id: z.string().uuid() });
const messageParams = z.object({ messageId: z.string().uuid() });

const feedbackBody = z.object({
  rating: z.enum(['up', 'down']),
  comment: z.string().max(2000).optional(),
});

const lessonsQuery = z.object({ workspaceId: z.string().uuid().optional() });

const feedbackQuery = z.object({
  rating: z.enum(['up', 'down']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * Whether the user may rate this message, and the workspace (shipment or FCL id)
 * its lessons hang off. Same access rules as the chat that produced it: supply →
 * getOwnedWorkspace, consolidated → getOwnedCollection, normal → conversation owner.
 */
async function accessibleScope(
  userId: string,
  msg: RatedMessage,
): Promise<{ ok: true; workspaceId: string | null } | { ok: false }> {
  switch (msg.chatKind) {
    case 'supply': {
      if (!msg.workspaceId) return { ok: false };
      const ws = await getOwnedWorkspace(userId, msg.workspaceId);
      return ws ? { ok: true, workspaceId: ws.id } : { ok: false };
    }
    case 'consolidated': {
      if (!msg.collectionId) return { ok: false };
      const col = await getOwnedCollection(userId, msg.collectionId);
      return col ? { ok: true, workspaceId: col.id } : { ok: false };
    }
    case 'normal':
      return msg.conversationOwnerId === userId ? { ok: true, workspaceId: null } : { ok: false };
    default:
      return { ok: false };
  }
}

/**
 * Відгуки й уроки: 👍/👎 on an assistant answer; a 👎 with a comment derives a
 * lesson SYNCHRONOUSLY (before the response), so the very next chat turn — the
 * frontend's «перевір ще раз» message — already has it in its system prompt.
 */
export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/messages/:messageId/feedback — rate an answer (re-rating replaces).
  app.post('/api/messages/:messageId/feedback', async (req, reply) => {
    const params = messageParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const body = feedbackBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: body.error.issues });
    }
    const userId = req.user!.sub;
    const msg = await getAssistantMessage(params.data.messageId);
    if (!msg) return reply.code(404).send({ error: 'not_found' });
    const scope = await accessibleScope(userId, msg);
    if (!scope.ok) return reply.code(404).send({ error: 'not_found' });

    const { rating } = body.data;
    const comment = (body.data.comment ?? '').trim();
    const feedback = await upsertFeedback({
      messageId: msg.id,
      conversationId: msg.conversationId,
      workspaceId: scope.workspaceId,
      userId,
      rating,
      comment,
    });

    let lesson: { id: string; text: string; scope: 'workspace' | 'global' } | null = null;
    if (rating === 'down' && comment) {
      const derived = await deriveLesson({
        question: msg.question,
        answer: msg.answer,
        comment,
        chatKind: msg.chatKind,
      });
      if (derived) {
        lesson = await saveLesson({
          ownerId: userId,
          workspaceId: scope.workspaceId,
          chatKind: msg.chatKind,
          lesson: derived,
          feedbackId: feedback.id,
          previousLessonId: feedback.lessonId,
        }).catch((err: unknown) => {
          req.log.error({ err }, 'lesson not stored');
          return null;
        });
      } else {
        req.log.warn({ messageId: msg.id }, 'no lesson derived from feedback');
      }
    }

    return reply.send({ ok: true, feedbackId: feedback.id, lesson });
  });

  // GET /api/lessons?workspaceId= — the user's global lessons + one workspace's.
  app.get('/api/lessons', async (req, reply) => {
    const q = lessonsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request', issues: q.error.issues });
    const userId = req.user!.sub;
    const workspaceId = q.data.workspaceId ?? null;
    if (workspaceId && !(await getOwnedWorkspace(userId, workspaceId))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.send({ lessons: await listLessons(userId, workspaceId) });
  });

  // DELETE /api/lessons/:id — deactivate (kept for history; no longer in prompts).
  app.delete('/api/lessons/:id', async (req, reply) => {
    const p = idParams.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const ok = await deactivateLesson(req.user!.sub, p.data.id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ ok: true });
  });

  // GET /api/feedback?rating=down&limit= — the user's feedback for the answer eval.
  app.get('/api/feedback', async (req, reply) => {
    const q = feedbackQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request', issues: q.error.issues });
    const feedback = await listFeedback(req.user!.sub, q.data.rating ?? null, q.data.limit);
    return reply.send({ feedback });
  });
}
