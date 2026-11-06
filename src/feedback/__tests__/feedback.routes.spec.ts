import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../lib/config.js', () => ({
  config: { JWT_SECRET: 'test-secret-that-is-long-enough-1234567890', JWT_EXPIRES_IN: '12h' },
}));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const WS = '33333333-3333-4333-8333-333333333333';
const MSG = '44444444-4444-4444-8444-444444444444';
const LESSON = '55555555-5555-4555-8555-555555555555';

const message = {
  id: MSG,
  conversationId: '66666666-6666-4666-8666-666666666666',
  chatKind: 'supply' as const,
  workspaceId: WS,
  collectionId: null,
  conversationOwnerId: null,
  answer: 'Пакувальний лист відсутній.',
  question: 'Чи повний пакет?',
};

const store = vi.hoisted(() => ({
  getAssistantMessage: vi.fn(),
  upsertFeedback: vi.fn(),
  saveLesson: vi.fn(),
  listLessons: vi.fn(),
  deactivateLesson: vi.fn(),
  listFeedback: vi.fn(),
}));
vi.mock('../store.js', () => store);

const derive = vi.hoisted(() => ({ deriveLesson: vi.fn() }));
vi.mock('../derive.js', () => derive);

const access = vi.hoisted(() => ({ getOwnedWorkspace: vi.fn(), getOwnedCollection: vi.fn() }));
vi.mock('../../shipments/workspaceAccess.js', () => ({ getOwnedWorkspace: access.getOwnedWorkspace }));
vi.mock('../../shipments/collectionAccess.js', () => ({ getOwnedCollection: access.getOwnedCollection }));

const { signToken } = await import('../../auth/jwt.js');
const { feedbackRoutes } = await import('../feedback.routes.js');

async function app() {
  const a = Fastify();
  await a.register(feedbackRoutes);
  return a;
}
const auth = { authorization: `Bearer ${signToken({ sub: USER, email: 'u@example.test' })}` };
const rate = (body: unknown, url = `/api/messages/${MSG}/feedback`) =>
  app().then((a) => a.inject({ method: 'POST', url, headers: auth, payload: body as object }));

beforeEach(() => {
  vi.clearAllMocks();
  store.getAssistantMessage.mockResolvedValue(message);
  store.upsertFeedback.mockResolvedValue({ id: 'fb1', lessonId: null });
  store.saveLesson.mockImplementation(async (i: { lesson: { text: string; scope: string } }) => ({ id: LESSON, ...i.lesson }));
  access.getOwnedWorkspace.mockImplementation(async (userId: string, id: string) =>
    userId === USER && id === WS ? { id: WS } : null,
  );
  access.getOwnedCollection.mockResolvedValue(null);
});

describe('POST /api/messages/:messageId/feedback', () => {
  it('requires auth', async () => {
    const res = await (await app()).inject({ method: 'POST', url: `/api/messages/${MSG}/feedback`, payload: { rating: 'up' } });
    expect(res.statusCode).toBe(401);
  });

  it('validates the body', async () => {
    expect((await rate({ rating: 'meh' })).statusCode).toBe(400);
    expect((await rate({ rating: 'down', comment: 'x'.repeat(2001) })).statusCode).toBe(400);
    expect((await rate({})).statusCode).toBe(400);
  });

  it('404 on a bad id, a missing/non-assistant message, or a foreign workspace', async () => {
    expect((await rate({ rating: 'up' }, '/api/messages/not-a-uuid/feedback')).statusCode).toBe(404);
    store.getAssistantMessage.mockResolvedValueOnce(null);
    expect((await rate({ rating: 'up' })).statusCode).toBe(404);
    store.getAssistantMessage.mockResolvedValueOnce({ ...message, workspaceId: OTHER });
    expect((await rate({ rating: 'up' })).statusCode).toBe(404);
    store.getAssistantMessage.mockResolvedValueOnce({ ...message, chatKind: 'normal', workspaceId: null, conversationOwnerId: OTHER });
    expect((await rate({ rating: 'up' })).statusCode).toBe(404);
    store.getAssistantMessage.mockResolvedValueOnce({ ...message, chatKind: 'consolidated', workspaceId: null, collectionId: WS });
    expect((await rate({ rating: 'up' })).statusCode).toBe(404);
    expect(store.upsertFeedback).not.toHaveBeenCalled();
  });

  it('👍 stores the rating without a lesson', async () => {
    const res = await rate({ rating: 'up' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, feedbackId: 'fb1', lesson: null });
    expect(derive.deriveLesson).not.toHaveBeenCalled();
  });

  it('👎 with a comment derives and stores a lesson before responding', async () => {
    derive.deriveLesson.mockResolvedValue({ text: 'Шукай документ за номером інвойсу.', scope: 'workspace' });
    const res = await rate({ rating: 'down', comment: '  PL є в папці Транспорт  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      feedbackId: 'fb1',
      lesson: { id: LESSON, text: 'Шукай документ за номером інвойсу.', scope: 'workspace' },
    });
    expect(derive.deriveLesson).toHaveBeenCalledWith({
      question: 'Чи повний пакет?',
      answer: 'Пакувальний лист відсутній.',
      comment: 'PL є в папці Транспорт',
      chatKind: 'supply',
    });
    expect(store.saveLesson).toHaveBeenCalledWith(expect.objectContaining({ ownerId: USER, workspaceId: WS, feedbackId: 'fb1' }));
  });

  it('a failed lesson call still stores the feedback', async () => {
    derive.deriveLesson.mockResolvedValue(null);
    const res = await rate({ rating: 'down', comment: 'не так' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, feedbackId: 'fb1', lesson: null });
    expect(store.upsertFeedback).toHaveBeenCalled();
    expect(store.saveLesson).not.toHaveBeenCalled();
  });

  it('a normal-chat message is rated by its conversation owner', async () => {
    store.getAssistantMessage.mockResolvedValueOnce({ ...message, chatKind: 'normal', workspaceId: null, conversationOwnerId: USER });
    expect((await rate({ rating: 'up' })).statusCode).toBe(200);
    expect(store.upsertFeedback).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: null }));
  });
});

describe('lessons and feedback lists', () => {
  it('GET /api/lessons 404s on a foreign workspace, 400 on a bad id', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: `/api/lessons?workspaceId=${OTHER}`, headers: auth })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/lessons?workspaceId=nope', headers: auth })).statusCode).toBe(400);
    store.listLessons.mockResolvedValue([]);
    const ok = await a.inject({ method: 'GET', url: `/api/lessons?workspaceId=${WS}`, headers: auth });
    expect(ok.json()).toEqual({ lessons: [] });
    expect(store.listLessons).toHaveBeenCalledWith(USER, WS);
  });

  it('DELETE /api/lessons/:id only for the owner', async () => {
    const a = await app();
    store.deactivateLesson.mockResolvedValueOnce(false);
    expect((await a.inject({ method: 'DELETE', url: `/api/lessons/${LESSON}`, headers: auth })).statusCode).toBe(404);
    store.deactivateLesson.mockResolvedValueOnce(true);
    expect((await a.inject({ method: 'DELETE', url: `/api/lessons/${LESSON}`, headers: auth })).json()).toEqual({ ok: true });
    expect(store.deactivateLesson).toHaveBeenLastCalledWith(USER, LESSON);
  });

  it('GET /api/feedback validates rating and limit', async () => {
    const a = await app();
    store.listFeedback.mockResolvedValue([]);
    expect((await a.inject({ method: 'GET', url: '/api/feedback?rating=bad', headers: auth })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/feedback?limit=0', headers: auth })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/feedback?rating=down&limit=20', headers: auth })).json()).toEqual({ feedback: [] });
    expect(store.listFeedback).toHaveBeenCalledWith(USER, 'down', 20);
  });
});
