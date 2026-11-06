import { describe, expect, it } from 'vitest';
import {
  buildLessonPrompt,
  LESSONS_HEADING,
  MAX_PROMPT_LESSONS,
  parseLessonReply,
  renderLessonsBlock,
  withLessons,
} from '../lesson.js';

describe('parseLessonReply', () => {
  it('reads a plain JSON reply', () => {
    expect(
      parseLessonReply('{"lesson": "Звіряй IBAN між усіма рахунками одного продавця.", "scope": "global"}'),
    ).toEqual({ text: 'Звіряй IBAN між усіма рахунками одного продавця.', scope: 'global' });
  });

  it('tolerates code fences and prose around the object', () => {
    const reply =
      'Ось урок:\n```json\n{"lesson": "Не називай документ відсутнім,\\n не пошукавши його за номером інвойсу.", "scope": "workspace"}\n```';
    expect(parseLessonReply(reply)).toEqual({
      text: 'Не називай документ відсутнім, не пошукавши його за номером інвойсу.',
      scope: 'workspace',
    });
  });

  it('garbage → null', () => {
    expect(parseLessonReply('')).toBeNull();
    expect(parseLessonReply('не знаю')).toBeNull();
    expect(parseLessonReply('{not json}')).toBeNull();
    expect(parseLessonReply('{"lesson": "Урок довжиною", "scope": "team"}')).toBeNull();
    expect(parseLessonReply('{"lesson": "", "scope": "global"}')).toBeNull();
    expect(parseLessonReply('{"text": "Звіряй IBAN", "scope": "global"}')).toBeNull();
  });
});

describe('buildLessonPrompt', () => {
  it('carries question, truncated answer and comment', () => {
    const prompt = buildLessonPrompt({
      question: 'Чи збігаються рахунки?',
      answer: 'x'.repeat(10_000),
      comment: 'IBAN у другому рахунку інший',
      chatKind: 'supply',
    });
    expect(prompt).toContain('Чи збігаються рахунки?');
    expect(prompt).toContain('IBAN у другому рахунку інший');
    expect(prompt).toContain('x'.repeat(6000));
    expect(prompt).not.toContain('x'.repeat(6001));
  });

  it('a normal chat asks for a global lesson only', () => {
    expect(buildLessonPrompt({ question: 'q', answer: 'a', comment: 'c', chatKind: 'normal' })).toContain(
      'scope завжди "global"',
    );
  });
});

describe('renderLessonsBlock', () => {
  it('no lessons → nothing', () => {
    expect(renderLessonsBlock([])).toBe('');
    expect(renderLessonsBlock([{ text: '  ', scope: 'global' }])).toBe('');
  });

  it('renders workspace and global lessons under the heading', () => {
    const block = renderLessonsBlock([
      { text: 'Шукай документ за номером інвойсу.', scope: 'workspace' },
      { text: 'Звіряй IBAN між рахунками.', scope: 'global' },
    ]);
    expect(block.startsWith(LESSONS_HEADING)).toBe(true);
    expect(block).toContain('- Шукай документ за номером інвойсу. (для цього постачання)');
    expect(block).toContain('- Звіряй IBAN між рахунками.\n');
  });

  it('caps at 15, keeping the newest (first) ones', () => {
    const lessons = Array.from({ length: 20 }, (_, i) => ({ text: `Урок номер ${i}.`, scope: 'global' as const }));
    const block = renderLessonsBlock(lessons);
    expect(block.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(MAX_PROMPT_LESSONS);
    expect(block).toContain('Урок номер 14.');
    expect(block).not.toContain('Урок номер 15.');
  });
});

describe('withLessons', () => {
  const cached = [{ type: 'text' as const, text: 'rules', cache_control: { type: 'ephemeral' as const } }];

  it('no block → the prompt unchanged', () => {
    expect(withLessons('rules', '')).toBe('rules');
    expect(withLessons(cached, '')).toBe(cached);
  });

  it('appends after the cache breakpoint', () => {
    const out = withLessons(cached, 'LESSONS');
    expect(out).toEqual([...cached, { type: 'text', text: 'LESSONS' }]);
    expect(withLessons('rules', 'LESSONS')).toEqual([
      { type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'LESSONS' },
    ]);
  });
});
