import { query } from '../db/pool.js';
import type { ChatKind, DerivedLesson, LessonScope } from './lesson.js';
import { MAX_PROMPT_LESSONS, renderLessonsBlock } from './lesson.js';

/** An assistant message with what ownership + the lesson call need. */
export interface RatedMessage {
  id: string;
  conversationId: string;
  chatKind: ChatKind;
  /** The scope owner per kind: workspace (supply), FCL (consolidated), user (normal). */
  workspaceId: string | null;
  collectionId: string | null;
  conversationOwnerId: string | null;
  answer: string;
  /** The user message that preceded the answer ('' if none). */
  question: string;
}

/** Loads an ASSISTANT message with its conversation scope. No ownership check — the route does it. */
export async function getAssistantMessage(messageId: string): Promise<RatedMessage | null> {
  const { rows } = await query<{
    id: string;
    conversation_id: string;
    chat_kind: ChatKind;
    workspace_id: string | null;
    collection_id: string | null;
    owner_id: string | null;
    content: string;
    question: string | null;
  }>(
    `SELECT m.id, m.conversation_id, c.chat_kind, c.workspace_id, c.collection_id, c.owner_id, m.content,
            (SELECT u.content FROM messages u
              WHERE u.conversation_id = m.conversation_id AND u.role = 'user' AND u.created_at <= m.created_at
              ORDER BY u.created_at DESC LIMIT 1) AS question
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND m.role = 'assistant'`,
    [messageId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    chatKind: r.chat_kind,
    workspaceId: r.workspace_id,
    collectionId: r.collection_id,
    conversationOwnerId: r.owner_id,
    answer: r.content,
    question: r.question ?? '',
  };
}

/** Upserts the user's rating of a message (re-rating replaces; the lesson link is kept). */
export async function upsertFeedback(input: {
  messageId: string;
  conversationId: string;
  workspaceId: string | null;
  userId: string;
  rating: 'up' | 'down';
  comment: string;
}): Promise<{ id: string; lessonId: string | null }> {
  const { rows } = await query<{ id: string; lesson_id: string | null }>(
    `INSERT INTO answer_feedback (message_id, conversation_id, workspace_id, user_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (message_id, user_id) DO UPDATE
       SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()
     RETURNING id, lesson_id`,
    [input.messageId, input.conversationId, input.workspaceId, input.userId, input.rating, input.comment],
  );
  const r = rows[0];
  if (!r) throw new Error('feedback upsert returned no row');
  return { id: r.id, lessonId: r.lesson_id };
}

/**
 * Stores a lesson derived from a feedback and links it. A re-rated 👎 replaces
 * the feedback's previous lesson (deactivated), so one answer teaches one lesson.
 */
export async function saveLesson(input: {
  ownerId: string;
  workspaceId: string | null;
  chatKind: ChatKind;
  lesson: DerivedLesson;
  feedbackId: string;
  previousLessonId: string | null;
}): Promise<{ id: string; text: string; scope: LessonScope }> {
  // A workspace lesson needs a workspace; otherwise it can only be global.
  const scope: LessonScope = input.lesson.scope === 'workspace' && input.workspaceId ? 'workspace' : 'global';
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_lessons (owner_id, workspace_id, chat_kind, text, scope, source_feedback_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.ownerId, input.workspaceId, input.chatKind, input.lesson.text, scope, input.feedbackId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('lesson insert returned no row');
  await query('UPDATE answer_feedback SET lesson_id = $2 WHERE id = $1', [input.feedbackId, id]);
  if (input.previousLessonId) {
    await query('UPDATE agent_lessons SET active = false WHERE id = $1 AND owner_id = $2', [
      input.previousLessonId,
      input.ownerId,
    ]);
  }
  return { id, text: input.lesson.text, scope };
}

/**
 * The lessons for one chat turn, newest first: the user's active global lessons
 * for this chat kind + active workspace lessons of this workspace/FCL.
 */
export async function lessonsForPrompt(input: {
  ownerId: string;
  chatKind: ChatKind;
  workspaceId: string | null;
}): Promise<DerivedLesson[]> {
  const { rows } = await query<{ text: string; scope: LessonScope }>(
    // The team learns together: a global lesson applies to everyone's chats of
    // that kind, a workspace lesson to everyone working on that shipment (the
    // chat route already checked access to it). ownerId is kept for the caller's
    // signature; only deleting a lesson is owner-scoped.
    `SELECT text, scope FROM agent_lessons
      WHERE active
        AND ((scope = 'global' AND chat_kind = $1)
          OR (scope = 'workspace' AND $2::uuid IS NOT NULL AND workspace_id = $2::uuid))
      ORDER BY created_at DESC
      LIMIT ${MAX_PROMPT_LESSONS}`,
    [input.chatKind, input.workspaceId],
  );
  return rows;
}

/**
 * The rendered lessons block for a chat turn ('' when none). Never throws: a
 * failed lookup must not break the chat turn — it just runs without lessons.
 */
export async function lessonsBlockFor(input: {
  ownerId: string;
  chatKind: ChatKind;
  workspaceId: string | null;
}): Promise<string> {
  try {
    return renderLessonsBlock(await lessonsForPrompt(input));
  } catch {
    return '';
  }
}

export interface LessonRow {
  id: string;
  text: string;
  scope: LessonScope;
  workspaceId: string | null;
  chatKind: ChatKind;
  createdAt: string;
  active: boolean;
}

/** The user's global lessons + (if given) one workspace's lessons, active and inactive. */
export async function listLessons(ownerId: string, workspaceId: string | null): Promise<LessonRow[]> {
  const { rows } = await query<LessonRow>(
    `SELECT id, text, scope, workspace_id AS "workspaceId", chat_kind AS "chatKind",
            created_at AS "createdAt", active
       FROM agent_lessons
      WHERE owner_id = $1
        AND (scope = 'global' OR ($2::uuid IS NOT NULL AND workspace_id = $2::uuid))
      ORDER BY created_at DESC
      LIMIT 500`,
    [ownerId, workspaceId],
  );
  return rows;
}

/** Deactivates the user's lesson. False when it is not theirs (or does not exist). */
export async function deactivateLesson(ownerId: string, lessonId: string): Promise<boolean> {
  const { rowCount } = await query('UPDATE agent_lessons SET active = false WHERE id = $1 AND owner_id = $2', [
    lessonId,
    ownerId,
  ]);
  return (rowCount ?? 0) > 0;
}

export interface FeedbackRow {
  id: string;
  messageId: string;
  conversationId: string | null;
  workspaceId: string | null;
  chatKind: ChatKind | null;
  rating: 'up' | 'down';
  question: string;
  answer: string;
  comment: string;
  lesson: string | null;
  createdAt: string;
}

/** The user's feedback, newest first — for building answer-eval regression cases. */
export async function listFeedback(
  userId: string,
  rating: 'up' | 'down' | null,
  limit: number,
): Promise<FeedbackRow[]> {
  const { rows } = await query<FeedbackRow>(
    `SELECT f.id, f.message_id AS "messageId", f.conversation_id AS "conversationId",
            f.workspace_id AS "workspaceId", c.chat_kind AS "chatKind", f.rating,
            COALESCE((SELECT u.content FROM messages u
                       WHERE u.conversation_id = m.conversation_id AND u.role = 'user'
                         AND u.created_at <= m.created_at
                       ORDER BY u.created_at DESC LIMIT 1), '') AS question,
            left(m.content, 2000) AS answer, f.comment, l.text AS lesson,
            f.created_at AS "createdAt"
       FROM answer_feedback f
       JOIN messages m ON m.id = f.message_id
       LEFT JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN agent_lessons l ON l.id = f.lesson_id
      WHERE f.user_id = $1 AND ($2::text IS NULL OR f.rating = $2::text)
      ORDER BY f.created_at DESC
      LIMIT $3`,
    [userId, rating, limit],
  );
  return rows;
}
