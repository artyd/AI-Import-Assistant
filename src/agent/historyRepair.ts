import type { ChatContentBlockParam, ChatMessageParam } from '../anthropic/client.js';

/**
 * Replay-safety for persisted conversation blocks. The Messages API rejects a
 * request (400) when history holds a `tool_use` without its `tool_result` in the
 * very next user message, a `tool_result` without its `tool_use`, an empty
 * assistant message, or starts with an assistant message. One such row used to
 * break a conversation for every later turn, so blocks are repaired both when a
 * turn is persisted and when history is rebuilt (heals rows stored earlier).
 * Pure — unit-tested.
 */

type Block = ChatContentBlockParam;

function blocksOf(m: ChatMessageParam): Block[] | null {
  return Array.isArray(m.content) ? (m.content as Block[]) : null;
}

function isEmpty(m: ChatMessageParam): boolean {
  if (typeof m.content === 'string') return m.content.trim().length === 0;
  return m.content.length === 0;
}

/** Drops thinking blocks (they must not be replayed across turns). */
function stripThinking(m: ChatMessageParam): ChatMessageParam {
  const b = blocksOf(m);
  if (m.role !== 'assistant' || !b) return m;
  return { role: 'assistant', content: b.filter((x) => x.type !== 'thinking' && x.type !== 'redacted_thinking') };
}

/**
 * Makes a message sequence replay-valid: strips thinking, removes tool_use
 * blocks whose tool_result is missing from the next user message (e.g. the
 * response was cut by max_tokens mid-call), removes orphan tool_results, drops
 * messages left empty, and (for a full history) drops leading non-user /
 * tool_result-only messages. A single persisted turn starts with the assistant,
 * so it is repaired with `requireUserStart: false`.
 */
export function repairBlocks(
  input: ChatMessageParam[],
  opts: { requireUserStart?: boolean } = {},
): ChatMessageParam[] {
  const requireUserStart = opts.requireUserStart ?? true;
  const msgs = input.map(stripThinking);
  const out: ChatMessageParam[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    const b = blocksOf(m);

    if (m.role === 'assistant' && b) {
      const next = msgs[i + 1];
      const nextBlocks = next && next.role === 'user' ? blocksOf(next) : null;
      const answered = new Set(
        (nextBlocks ?? [])
          .filter((x): x is Extract<Block, { type: 'tool_result' }> => x.type === 'tool_result')
          .map((x) => x.tool_use_id),
      );
      const kept = b.filter((x) => x.type !== 'tool_use' || answered.has(x.id));
      if (kept.length) out.push({ role: 'assistant', content: kept });
      continue;
    }

    if (m.role === 'user' && b) {
      const prev = out[out.length - 1];
      const prevBlocks = prev && prev.role === 'assistant' ? blocksOf(prev) : null;
      const asked = new Set(
        (prevBlocks ?? [])
          .filter((x): x is Extract<Block, { type: 'tool_use' }> => x.type === 'tool_use')
          .map((x) => x.id),
      );
      const kept = b.filter((x) => x.type !== 'tool_result' || asked.has(x.tool_use_id));
      if (kept.length) out.push({ role: 'user', content: kept });
      continue;
    }

    if (!isEmpty(m)) out.push(m);
  }

  // History must open with a real user message (not an assistant turn and not a
  // tool_result-only message whose tool_use was windowed away).
  while (requireUserStart && out.length) {
    const first = out[0]!;
    const fb = blocksOf(first);
    const toolResultOnly = fb !== null && fb.length > 0 && fb.every((x) => x.type === 'tool_result');
    if (first.role === 'user' && !toolResultOnly) break;
    out.shift();
  }
  return out;
}

/**
 * Replaces tool_use / tool_result blocks with nothing, keeping the prose. Used
 * when a turn advertises NO tools (the API rejects tool blocks without a `tools`
 * definition) — e.g. a chat whose history holds logist calls after LOGIST_MCP_URL
 * was unset.
 */
export function stripToolBlocks(input: ChatMessageParam[]): ChatMessageParam[] {
  const out: ChatMessageParam[] = [];
  for (const m of input) {
    const b = blocksOf(m);
    if (!b) {
      if (!isEmpty(m)) out.push(m);
      continue;
    }
    const kept = b.filter((x) => x.type !== 'tool_use' && x.type !== 'tool_result');
    if (kept.length) out.push({ role: m.role, content: kept });
  }
  return repairBlocks(out);
}
