import { anthropic } from '../../anthropic/client.js';
import { runWithAnthropicLimit } from '../../anthropic/limiter.js';
import { config } from '../../config.js';
import { renderText } from './render.js';
import type { InstructionDraft } from './types.js';

/**
 * «Доопрацювати з ШІ»: turns a free-form request into extra clauses for the
 * letter (EN for the supplier + UK for the check copy). It only PROPOSES — the
 * constructor shows the clauses as a diff and the user accepts or rejects; the
 * deterministic template itself is never rewritten.
 */
export interface RefineProposal {
  clauses: { en: string; uk: string }[];
}

export async function proposeRefinement(d: InstructionDraft, request: string): Promise<RefineProposal> {
  const msg = await runWithAnthropicLimit(() =>
    anthropic.messages.create({
      model: config.REPORT_SUMMARY_MODEL,
      max_tokens: 1200,
      output_config: { effort: 'low' },
      system:
        'You add extra clauses to a shipping-instruction letter to a supplier. Write only what the user ' +
        'asked for, concise and professional, consistent with the existing letter; do not repeat what the ' +
        'letter already says and do not invent facts (names, numbers, dates) that are not in the letter or ' +
        'the request. Reply with JSON only: {"clauses":[{"en":"…","uk":"…"}]} — en = clause for the ' +
        'supplier in English, uk = the same in Ukrainian. 1–3 clauses.',
      messages: [{ role: 'user', content: `LETTER:\n${renderText(d, 'en')}\n\nREQUEST:\n${request}` }],
    }),
  );
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const parsed = JSON.parse(json) as { clauses?: { en?: unknown; uk?: unknown }[] };
    const clauses = (parsed.clauses ?? [])
      .map((c) => ({ en: String(c.en ?? '').trim(), uk: String(c.uk ?? '').trim() }))
      .filter((c) => c.en)
      .slice(0, 3);
    return { clauses };
  } catch {
    return { clauses: [] };
  }
}
