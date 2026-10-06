import Anthropic from '@anthropic-ai/sdk';
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
  /** Context-window usage of this turn (for the UI's context widget). */
  usage: TurnUsage;
}

export interface TurnUsage {
  /** Tokens in the model's context on the LAST call of the turn (after server-side clearing). */
  contextTokens: number;
  /** Largest context on any call of the turn. */
  peakContextTokens: number;
  /** The model's context window (AGENT_CONTEXT_TOKENS). */
  contextWindow: number;
  /** Old tool results the API cleared this turn to keep reading (tokens / tool uses). */
  clearedTokens: number;
  clearedToolUses: number;
  outputTokens: number;
  model: string;
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
// Models with preserved thinking (thinking blocks bound to the conversation):
// any change to the system prompt (per-shipment digest), the tools or an earlier
// message — our history window, repairs — would invalidate replayed thinking and,
// on new accounts, 400. "drop_block" drops such blocks instead. Older models reject
// the field («block_binding: Extra inputs are not permitted»), so it is gated.
const PRESERVED_THINKING = /^claude-(sonnet-5-5|opus-5-5|fable-5-1|mythos-5-1)\b/;
const preservedThinking = PRESERVED_THINKING.test(MODEL);
const BETAS = [
  'context-management-2025-06-27',
  ...(preservedThinking ? ['thinking-binding-controls-2026-08-01'] : []),
];
const THINKING = preservedThinking
  ? ({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } as const)
  : ({ type: 'adaptive' } as const);

// Server-side context editing: once a request passes AGENT_CLEAR_TRIGGER_TOKENS,
// the API clears the OLDEST tool results (documents read earlier), keeping the
// most recent ones word for word — so the agent keeps reading new files instead
// of stopping when the context fills up. The client history stays intact; on
// preserved-thinking models server-side clearing never invalidates thinking.
const CONTEXT_MANAGEMENT = {
  edits: [
    {
      type: 'clear_tool_uses_20250919' as const,
      trigger: { type: 'input_tokens' as const, value: config.AGENT_CLEAR_TRIGGER_TOKENS },
      keep: { type: 'tool_uses' as const, value: config.AGENT_CLEAR_KEEP_TOOL_USES },
      // Clear in big steps: each clearing rewrites the cached prefix.
      clear_at_least: { type: 'input_tokens' as const, value: 50_000 },
    },
  ],
};

// Hard ceiling for ONE step's new tool results: several huge reads at once could
// overflow the window before clearing can help. Only then is the largest result
// replaced by a note asking to read it in parts — the loop keeps going.
const STEP_CEILING_TOKENS = Math.floor(config.AGENT_CONTEXT_TOKENS * 0.95);

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

const SPLIT_READ_RESULT =
  'Результат завеликий, щоб завантажити його разом з іншими в одному кроці. Прочитай цей файл ' +
  'частинами — read_file з range (сторінки "1-10", "11-20" або символи "0-100000").';

/** Replaces the largest tool results with a "read it in parts" note until the step fits `budget`. */
function splitOversizedResults(blocks: ChatContentBlockParam[], budget: number): void {
  const order = blocks
    .map((b, i) => ({ i, size: JSON.stringify(b).length }))
    .sort((a, b) => b.size - a.size);
  for (const { i } of order) {
    if (estimateTokens(blocks) < budget) return;
    const b = blocks[i];
    if (b && b.type === 'tool_result') blocks[i] = { ...b, content: SPLIT_READ_RESULT, is_error: true };
  }
}

type StreamBase = { system: ChatSystem; messages: ChatMessageParam[]; tools: ChatTool[]; signal?: AbortSignal };
type StreamExtra = { tool_choice?: { type: 'none' } };
type ModelMessage = Anthropic.Beta.Messages.BetaMessage;

// Set once the API rejects the beta context features (unsupported model/account):
// later calls go out as plain requests instead of failing every chat turn.
let betaFeaturesRejected = false;
const BETA_FIELD_ERROR = /context_management|clear_tool_uses|block_binding|thinking-binding|context-management|anthropic-beta/i;

/**
 * One streamed model call with the shared request settings: server-side clearing
 * of old tool results + (on preserved-thinking models) drop_block. If the API
 * rejects those beta fields with a 400 before any text streamed, the call is
 * retried once as a plain request and the features stay off for the process.
 */
async function callModel(
  base: StreamBase,
  extra: StreamExtra,
  onStream: (s: { on(ev: 'contentBlock', cb: () => void): unknown; on(ev: 'text', cb: (t: string) => void): unknown }) => void,
): Promise<ModelMessage> {
  if (!betaFeaturesRejected) {
    let streamed = false;
    try {
      const stream = anthropic.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          thinking: THINKING,
          output_config: { effort: config.AGENT_EFFORT },
          system: base.system as never,
          messages: base.messages as never,
          tools: base.tools as never,
          context_management: CONTEXT_MANAGEMENT,
          betas: BETAS,
          ...extra,
        },
        { signal: base.signal },
      );
      stream.on('text', () => {
        streamed = true;
      });
      onStream(stream);
      return await stream.finalMessage();
    } catch (err) {
      const rejected =
        !streamed && err instanceof Anthropic.BadRequestError && BETA_FIELD_ERROR.test(err.message);
      if (!rejected) throw err;
      betaFeaturesRejected = true;
      // eslint-disable-next-line no-console
      console.error(`Agent: beta context features rejected, falling back to plain requests: ${err.message}`);
    }
  }
  const stream = anthropic.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: config.AGENT_EFFORT },
      system: base.system as never,
      messages: base.messages as never,
      tools: base.tools as never,
      ...extra,
    },
    { signal: base.signal },
  );
  onStream(stream);
  return stream.finalMessage();
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
  const ctxStats = { last: 0, peak: 0, clearedTokens: 0, clearedToolUses: 0 };
  const noteContext = (m: {
    usage: { input_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    context_management?: { applied_edits?: { type: string; cleared_input_tokens?: number; cleared_tool_uses?: number }[] } | null;
  }): void => {
    const inCtx =
      m.usage.input_tokens + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
    ctxStats.last = inCtx;
    ctxStats.peak = Math.max(ctxStats.peak, inCtx);
    for (const e of m.context_management?.applied_edits ?? []) {
      ctxStats.clearedTokens += e.cleared_input_tokens ?? 0;
      ctxStats.clearedToolUses += e.cleared_tool_uses ?? 0;
    }
  };
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
  // Paragraph breaks between text blocks + streaming tokens to the client.
  const wireStream: Parameters<typeof callModel>[2] = (stream) => {
    stream.on('contentBlock', () => {
      blockBreak = true;
    });
    stream.on('text', emitText);
  };
  const citations: Citation[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let toolsStillPending = false;
  let error: string | undefined;

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (params.signal?.aborted) throw new Error('client_disconnected');
      blockBreak = true;
      const msg = await callModel(
        { system: systemParam, messages: request(), tools: toolsParam, signal: params.signal },
        {},
        wireStream,
      );
      track(msg.usage);
      noteContext(msg);
      // Preserve the full assistant content (incl. thinking + tool_use blocks).
      messages.push({ role: 'assistant', content: msg.content as ChatMessageParam['content'] });

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

      // One step's new results alone must not overflow the window (older results
      // are cleared server-side; these are the newest and are kept). If they would,
      // the largest are swapped for "read it in parts" notes and the loop goes on.
      const contextBefore =
        msg.usage.input_tokens +
        (msg.usage.cache_read_input_tokens ?? 0) +
        (msg.usage.cache_creation_input_tokens ?? 0) +
        msg.usage.output_tokens;
      if (contextBefore + estimateTokens(toolResults) >= STEP_CEILING_TOKENS) {
        splitOversizedResults(toolResults, STEP_CEILING_TOKENS - contextBefore);
      }
      if (iteration === MAX_ITERATIONS - 1) {
        toolsStillPending = true;
        break;
      }
    }

    // Closing pass that may NOT use tools, when (a) tools are still pending
    // (iterations exhausted), or (b) the turn produced no
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
      blockBreak = true;
      const msg = await callModel(
        { system: systemParam, messages: request(), tools: toolsParam, signal: params.signal },
        toolsParam.length > 0 ? { tool_choice: { type: 'none' } } : {},
        wireStream,
      );
      track(msg.usage);
      noteContext(msg);
      // The nudge is a one-off steer for this call — keep it out of the replayed
      // history (user(tool_results) → assistant(answer) is a valid sequence).
      messages.splice(nudgeIdx, 1);
      messages.push({ role: 'assistant', content: msg.content as ChatMessageParam['content'] });
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
  return {
    text,
    citations: dedupe(citations),
    toolCalls,
    turnBlocks,
    error,
    usage: {
      contextTokens: ctxStats.last,
      peakContextTokens: ctxStats.peak,
      contextWindow: config.AGENT_CONTEXT_TOKENS,
      clearedTokens: ctxStats.clearedTokens,
      clearedToolUses: ctxStats.clearedToolUses,
      outputTokens: usage.output,
      model: MODEL,
    },
  };
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
