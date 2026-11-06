import { anthropic } from '../lib/anthropic/client.js';
import { runWithAnthropicLimit } from '../lib/anthropic/limiter.js';
import { config } from '../lib/config.js';
import { buildLessonPrompt, parseLessonReply, type ChatKind, type DerivedLesson } from './lesson.js';

/**
 * One cheap Haiku call (CLASSIFY_MODEL, like the other one-shot classifiers):
 * a 👎 + comment → one reusable lesson. Plain JSON in text, parsed with zod —
 * no forced tool_choice. Any failure → null (the feedback is stored anyway).
 */
export async function deriveLesson(input: {
  question: string;
  answer: string;
  comment: string;
  chatKind: ChatKind;
}): Promise<DerivedLesson | null> {
  try {
    const msg = await runWithAnthropicLimit(() =>
      anthropic.messages.create({
        model: config.CLASSIFY_MODEL,
        // Adaptive thinking counts against max_tokens — leave room for the answer.
        max_tokens: 2000,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: buildLessonPrompt(input) }],
      }),
    );
    const text = msg.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const lesson = parseLessonReply(text);
    if (!lesson) return null;
    // A global chat has no shipment to scope a lesson to.
    return input.chatKind === 'normal' ? { ...lesson, scope: 'global' } : lesson;
  } catch {
    return null;
  }
}
