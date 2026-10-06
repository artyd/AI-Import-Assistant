import {
  anthropic,
  MODEL,
  type ChatMessageParam,
  type ChatContentBlockParam,
  type ChatSystem,
  type ChatTool,
} from '../anthropic/client.js';
import { config } from '../config.js';
import type { SseStream } from '../sse/sse.js';
import type { Citation, ToolCallRecord } from '../services/conversations.js';
import { toolDefinitions, executeTool, type ToolContext } from './tools.js';
import { repairBlocks, stripToolBlocks } from './historyRepair.js';

export interface AgentTurnParams {
  /**
   * Present only for shipment-scoped ("supply") turns — it builds the ToolContext
   * the shipment tools need. Global ("normal") turns run without any scope.
   */
  workspaceId?: string;
  /**
   * Present for consolidated (Збірник) turns — scopes the run_consolidated_analysis
   * tool. `ownerId` lets that tool persist the analysis like the REST route.
   */
  collectionId?: string;
  ownerId?: string;
  /** A plain string, or blocks (supply chat: cached rules + per-shipment state). */
  system: string | ChatSystem;
  /** Prior turns as replay-ready Anthropic message params (may include tool blocks). */
  history: ChatMessageParam[];
  userMessage: string;
  sse: SseStream;
  /**
   * Tool set advertised to Claude for this turn. Defaults to the full
   * `toolDefinitions` (supply chat). Pass `[]` for tool-less kinds (normal /
   * consolidated in this slice) — the loop then streams a single assistant
   * message with no tool_use round-trips.
   */
  tools?: typeof toolDefinitions;
  /** Aborts the turn (client disconnected) — no further model calls or tools. */
  signal?: AbortSignal;
}

export interface AgentTurnResult {
  text: string;
  citations: Citation[];
  toolCalls: ToolCallRecord[];
  /** This turn's full content blocks (assistant tool_use/text + tool_result msgs),
   *  for lossless replay next turn. Empty when the turn errored mid-way. */
  turnBlocks: ChatMessageParam[];
  /** Set when the model/stream errored — caller persists partial text + surfaces it. */
  error?: string;
}

// ── Prompt caching ────────────────────────────────────────────────────────────
// Every iteration re-sends tools + system + the whole history; without caching
// that was billed in full up to 15× per turn. Breakpoints (max 4): the last tool,
// the static system rules, the end of prior history, and the newest message — so
// each iteration and the next turn read the shared prefix at ~10% of the price.
const EPHEMERAL = { type: 'ephemeral' } as const;

function cachedSystem(system: string | ChatSystem): ChatSystem {
  if (typeof system !== 'string') return system;
  return [{ type: 'text', text: system, cache_control: EPHEMERAL }];
}

function cachedTools(tools: ChatTool[]): ChatTool[] {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1]!;
  return [...tools.slice(0, -1), { ...last, cache_control: EPHEMERAL } as ChatTool];
}

/** Copy of `messages` with a cache breakpoint on the last block of each listed index. */
function withBreakpoints(messages: ChatMessageParam[], indexes: number[]): ChatMessageParam[] {
  const out = [...messages];
  for (const i of indexes) {
    const m = out[i];
    if (!m) continue;
    const blocks: ChatContentBlockParam[] =
      typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [...m.content];
    const lastIdx = blocks.length - 1;
    const last = blocks[lastIdx];
    // Thinking blocks can't carry cache_control; the newest message is always a
    // user message (text or tool_results), so this only skips odd history ends.
    if (!last || last.type === 'thinking' || last.type === 'redacted_thinking') continue;
    blocks[lastIdx] = { ...last, cache_control: EPHEMERAL } as ChatContentBlockParam;
    out[i] = { role: m.role, content: blocks } as ChatMessageParam;
  }
  return out;
}

const MAX_ITERATIONS = 14;
// Completion budget per model call. Adaptive thinking counts against it: at the
// old 12k a long reasoning pass (customs-declaration arithmetic over 5 lines) used
// the whole budget and the turn ended with NO visible text. Streaming, so a large
// cap doesn't risk HTTP timeouts.
const MAX_TOKENS = config.AGENT_MAX_TOKENS;
// Input size at which a turn stops calling tools and answers from what it has —
// so a reading spree over a big shipment can't overflow the context window.
const CONTEXT_GUARD_TOKENS = Math.floor(config.AGENT_CONTEXT_TOKENS * config.AGENT_CONTEXT_GUARD);

const FINAL_ANSWER_NUDGE =
  'Сформулюй відповідь користувачу на основі вже зібраних даних (без нових викликів інструментів). ' +
  'Якщо чогось не встиг перевірити — прямо скажи, що саме.';
const EMPTY_ANSWER_FALLBACK =
  'Не вдалося сформувати відповідь на це питання. Спробуйте переформулювати або звузити його ' +
  '(наприклад, до одного документа чи одного товару).';

function hasText(content: readonly { type: string; text?: string }[]): boolean {
  return content.some((b) => b.type === 'text' && (b.text ?? '').trim().length > 0);
}

// Conservative token estimate for tool results: ~2 chars/token covers Cyrillic
// and leaves margin for CJK-heavy documents (Chinese export declarations).
function estimateTokens(blocks: ChatContentBlockParam[]): number {
  return Math.ceil(JSON.stringify(blocks).length / 2);
}

const UNLOADED_RESULT =
  'Результат не завантажено: вичерпано бюджет контексту цього ходу. Відповідай за вже прочитаним; ' +
  'якщо цих даних бракує — скажи користувачу, що файл варто розглянути окремим питанням.';

/** Replaces the largest tool results with a stub until the batch fits `budget` tokens. */
function shrinkToolResults(blocks: ChatContentBlockParam[], budget: number): void {
  const order = blocks
    .map((b, i) => ({ i, size: JSON.stringify(b).length }))
    .sort((a, b) => b.size - a.size);
  for (const { i } of order) {
    if (estimateTokens(blocks) < budget) return;
    const b = blocks[i];
    if (b && b.type === 'tool_result') blocks[i] = { ...b, content: UNLOADED_RESULT };
  }
}

/**
 * Single-agent, hybrid-retrieval tool-use loop. One Claude conversation with the
 * tools advertised in `toolDefinitions` — retrieval (search_documents / read_file
 * / list_files) plus the shipment tools (checklist, discrepancies, supplier
 * instruction, report, context, inbox sorting). The model decides which tool(s)
 * to call and in what order — we do not hardcode a retrieval pipeline. Text is
 * streamed as `token` events; each tool call/result is
 * surfaced as `tool_call` / `tool_result` events for the UI's working-status
 * chips and agent-log panel.
 */
export async function runAgentTurn(params: AgentTurnParams): Promise<AgentTurnResult> {
  const { workspaceId, collectionId, ownerId, system, history, userMessage, sse } = params;
  const tools = params.tools ?? toolDefinitions;
  // One context shape covers every chat kind; each field is optional. Shipment
  // tools narrow via requireWorkspace(ctx), consolidated via ctx.collectionId, and
  // the logist reference tools need no scope at all — so a normal (workspace-less)
  // turn can still call them. Handlers reject a mis-scoped call with a clear error.
  const ctx: ToolContext = { workspaceId, collectionId, ownerId };

  // History is already replay-ready message params (may carry prior tool blocks).
  // The API rejects tool blocks when no `tools` are advertised — a tool-less
  // turn (e.g. logist disabled) replays the prose only.
  const messages: ChatMessageParam[] = [
    ...(tools.length === 0 ? stripToolBlocks(history) : history),
    { role: 'user' as const, content: userMessage },
  ];
  const seedLen = messages.length; // everything appended past this = THIS turn
  const systemParam = cachedSystem(system);
  const toolsParam = cachedTools(tools);
  const historyEnd = seedLen - 2; // last message of prior history (−1 = none)
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const request = (): ChatMessageParam[] =>
    withBreakpoints(messages, historyEnd >= 0 ? [historyEnd, messages.length - 1] : [messages.length - 1]);
  const track = (u: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  }): void => {
    usage.input += u.input_tokens;
    usage.output += u.output_tokens;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
  };

  let text = '';
  // Each text block (one per model call, or after a tool/thinking block) is its
  // own paragraph. Streamed back-to-back they used to glue into one line —
  // "…хвилинку!## Комплектність" — breaking the Markdown heading.
  let blockBreak = false;
  const emitText = (delta: string): void => {
    let out = delta;
    if (blockBreak && text.length > 0 && !/\n\s*$/.test(text) && !/^\s*\n/.test(delta)) {
      out = `\n\n${delta}`;
    }
    blockBreak = false;
    text += out;
    sse.send('token', { text: out });
  };
  const citations: Citation[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let toolsStillPending = false;
  let error: string | undefined;

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (params.signal?.aborted) throw new Error('client_disconnected');
      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        system: systemParam,
        messages: request(),
        tools: toolsParam,
      }, { signal: params.signal });

      blockBreak = true;
      stream.on('contentBlock', () => {
        blockBreak = true;
      });
      stream.on('text', emitText);

      const msg = await stream.finalMessage();
      track(msg.usage);
      // Preserve the full assistant content (incl. thinking + tool_use blocks).
      messages.push({ role: 'assistant', content: msg.content });

      // Output cap hit mid tool call: the tool input is truncated JSON — don't run
      // it; answer with an error result so the model retries instead of the turn
      // ending with no answer (and an unpaired tool_use).
      const cutToolUse = msg.stop_reason === 'max_tokens' && msg.content.some((b) => b.type === 'tool_use');
      if (msg.stop_reason !== 'tool_use' && !cutToolUse) break;

      const toolResults: ChatContentBlockParam[] = [];
      for (const block of msg.content) {
        if (block.type !== 'tool_use') continue;
        if (cutToolUse) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Виклик обрізано лімітом відповіді — повтори його коротше або відповідай без нього.',
            is_error: true,
          });
          continue;
        }
        sse.send('tool_call', { tool: block.name, input: block.input });

        let outcome;
        try {
          outcome = await executeTool(block.name, block.input, ctx);
        } catch (err) {
          outcome = {
            result: `Помилка інструмента: ${(err as Error).message}`,
            summary: `Помилка: ${block.name}`,
            citations: [] as Citation[],
          };
        }

        toolCalls.push({ tool: block.name, input: block.input, summary: outcome.summary });
        citations.push(...outcome.citations);
        sse.send('tool_result', { tool: block.name, summary: outcome.summary });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: outcome.result,
        });
      }

      messages.push({ role: 'user', content: toolResults });

      // Iterations exhausted, or the next request would come close to the context
      // window (this call's input + its output + the new tool results, ~3 chars per
      // token): stop reading and answer from what has been gathered.
      const priorInput =
        msg.usage.input_tokens +
        (msg.usage.cache_read_input_tokens ?? 0) +
        (msg.usage.cache_creation_input_tokens ?? 0) +
        msg.usage.output_tokens;
      if (priorInput + estimateTokens(toolResults) >= CONTEXT_GUARD_TOKENS) {
        // Several big reads in one step can overshoot the window by themselves —
        // unload the largest results so the closing request still fits.
        shrinkToolResults(toolResults, CONTEXT_GUARD_TOKENS - priorInput);
        toolsStillPending = true;
        break;
      }
      if (iteration === MAX_ITERATIONS - 1) {
        toolsStillPending = true;
        break;
      }
    }

    // Closing pass that may NOT use tools, when (a) tools are still pending
    // (iterations or context budget exhausted), or (b) the turn produced no
    // visible text at all — e.g. adaptive thinking used the whole output budget, or
    // the model ended on thinking only. Without (b) the user got an empty answer.
    // `tools` must still be sent (history holds tool blocks — the API 400s without
    // a definition); tool_choice none forbids new calls.
    // (b) is judged on the LAST model message: earlier iterations' progress lines
    // («Читаю файл…») are not an answer.
    const last = messages[messages.length - 1];
    const endedWithoutAnswer =
      !!last && last.role === 'assistant' && Array.isArray(last.content) && !hasText(last.content);
    if (!params.signal?.aborted && (toolsStillPending || endedWithoutAnswer || !text.trim())) {
      // A trailing assistant message with no text and no tool_use is an empty
      // block for replay — drop it before asking for the answer.
      if (endedWithoutAnswer) messages.pop();
      const nudgeIdx = messages.push({ role: 'user', content: FINAL_ANSWER_NUDGE }) - 1;
      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        system: systemParam,
        messages: request(),
        tools: toolsParam,
        ...(toolsParam.length > 0 ? { tool_choice: { type: 'none' as const } } : {}),
      }, { signal: params.signal });
      blockBreak = true;
      stream.on('contentBlock', () => {
        blockBreak = true;
      });
      stream.on('text', emitText);
      const msg = await stream.finalMessage();
      track(msg.usage);
      // The nudge is a one-off steer for this call — keep it out of the replayed
      // history (user(tool_results) → assistant(answer) is a valid sequence).
      messages.splice(nudgeIdx, 1);
      messages.push({ role: 'assistant', content: msg.content });
    }

    // Never end a turn silently: the UI would show an empty bubble.
    if (!params.signal?.aborted && !text.trim()) emitText(EMPTY_ANSWER_FALLBACK);
  } catch (err) {
    // Stream/model failure: keep whatever text streamed so the caller can persist a
    // partial answer (survives reload) instead of losing it.
    error = (err as Error).message;
  }

  // One line per turn so prompt-cache effectiveness is visible in prod logs.
  // eslint-disable-next-line no-console
  console.log(
    `Agent turn: input ${usage.input} + cache_read ${usage.cacheRead} + cache_write ${usage.cacheWrite}, ` +
      `output ${usage.output} tokens.`,
  );

  // Only persist replay blocks for a clean turn, and repair them (a response cut
  // by max_tokens mid-tool-call, or a thinking-only message, would otherwise be
  // an unpaired/empty block that 400s every later turn).
  const turnBlocks = error ? [] : repairBlocks(messages.slice(seedLen), { requireUserStart: false });
  return { text, citations: dedupe(citations), toolCalls, turnBlocks, error };
}

function dedupe(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key = `${c.file}#${c.page ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}
