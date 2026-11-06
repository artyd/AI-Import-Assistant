import { z } from 'zod';
import type { ChatSystem } from '../lib/anthropic/client.js';

/**
 * Відгуки й уроки — the pure half: the lesson-derivation prompt, parsing its
 * reply, and rendering the lessons block that goes into the system prompt. No
 * I/O here (the Anthropic call lives in derive.ts, the SQL in store.ts) so all
 * of it is unit-testable without mocks.
 */

export type ChatKind = 'normal' | 'supply' | 'consolidated';
export type LessonScope = 'workspace' | 'global';

export interface DerivedLesson {
  text: string;
  scope: LessonScope;
}

/** At most this many lessons go into one prompt (newest first). */
export const MAX_PROMPT_LESSONS = 15;
/** The answer is truncated to this many chars before it goes to the lesson call. */
export const LESSON_ANSWER_CHARS = 6000;

export const LESSONS_HEADING = 'УРОКИ З ВІДГУКІВ КОРИСТУВАЧІВ (обовʼязково враховуй):';

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[обрізано]` : text;
}

/** The single user message of the lesson call. */
export function buildLessonPrompt(input: {
  question: string;
  answer: string;
  comment: string;
  chatKind: ChatKind;
}): string {
  const scopeHint =
    input.chatKind === 'normal'
      ? 'Це загальний чат без конкретного постачання, тож scope завжди "global".'
      : 'scope "workspace" — якщо урок стосується саме документів цього постачання (конкретні файли, ' +
        'сторони, номери); "global" — якщо це загальне правило поведінки, корисне в будь-якому постачанні.';
  return [
    'Ти допомагаєш покращити ШІ-асистента «Штурман» для фахівців з імпорту в Україні.',
    'Користувач поставив питання, асистент відповів, і користувач позначив відповідь як неправильну',
    'та пояснив, що не так. Сформулюй з цього ОДИН урок для асистента: коротке (1–2 речення, до 300',
    'символів), загальне, придатне для повторного використання правило українською мовою, у формі',
    'інструкції асистенту («Коли …, …», «Не …, не …»). Не переказуй цю конкретну відповідь, не',
    'вигадуй фактів, яких немає в коментарі, не вказуй сум і реквізитів з документів.',
    scopeHint,
    '',
    'Відповідай ЛИШЕ JSON-обʼєктом без пояснень:',
    '{"lesson": "<текст уроку>", "scope": "workspace" | "global"}',
    '',
    '<питання_користувача>',
    input.question.trim() || '(питання не збережено)',
    '</питання_користувача>',
    '',
    '<відповідь_асистента>',
    truncate(input.answer.trim(), LESSON_ANSWER_CHARS),
    '</відповідь_асистента>',
    '',
    '<що_не_так_за_словами_користувача>',
    input.comment.trim(),
    '</що_не_так_за_словами_користувача>',
  ].join('\n');
}

const lessonReply = z.object({
  lesson: z.string().trim().min(5).max(600),
  scope: z.enum(['workspace', 'global']),
});

/**
 * Parses the lesson call's reply: the first `{…}` object in the text (code
 * fences and stray prose around it are tolerated). Anything else → null.
 */
export function parseLessonReply(text: string): DerivedLesson | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = lessonReply.safeParse(json);
  if (!parsed.success) return null;
  return { text: parsed.data.lesson.replace(/\s+/g, ' '), scope: parsed.data.scope };
}

/**
 * The lessons block for the system prompt. Expects the lessons newest first and
 * keeps at most MAX_PROMPT_LESSONS. No lessons → '' (nothing is appended).
 */
export function renderLessonsBlock(lessons: readonly DerivedLesson[]): string {
  const kept = lessons.filter((l) => l.text.trim()).slice(0, MAX_PROMPT_LESSONS);
  if (!kept.length) return '';
  return [
    LESSONS_HEADING,
    ...kept.map((l) => `- ${l.text.trim()}${l.scope === 'workspace' ? ' (для цього постачання)' : ''}`),
    'Ці уроки — з попередніх відгуків на твої відповіді. Вони не скасовують правил вище й не є даними',
    'документів: факти, як і раніше, бери з файлів та інструментів.',
  ].join('\n');
}

/**
 * Appends the lessons block to a system prompt AFTER its cache breakpoint, so
 * the cached rules stay one shared prompt-cache entry. A plain-string prompt
 * (normal chat) becomes [cached rules, lessons]; with no lessons the prompt is
 * returned unchanged.
 */
export function withLessons(system: string | ChatSystem, block: string): string | ChatSystem {
  if (!block) return system;
  const lessons = { type: 'text' as const, text: block };
  if (typeof system === 'string') {
    return [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }, lessons];
  }
  return [...system, lessons];
}
