import Anthropic from '@anthropic-ai/sdk';
import { anthropic, MODEL } from '../anthropic/client.js';
import type { SseStream } from '../sse/sse.js';
import type { Citation, ToolCallRecord } from '../services/conversations.js';
import { toolDefinitions, executeTool, type ToolContext } from './tools.js';

export interface AgentTurnParams {
  workspaceId: string;
  system: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  userMessage: string;
  sse: SseStream;
}

export interface AgentTurnResult {
  text: string;
  citations: Citation[];
  toolCalls: ToolCallRecord[];
}

const MAX_ITERATIONS = 8;

/**
 * Single-agent, hybrid-retrieval tool-use loop. One Claude conversation with
 * three tools (search_documents / read_file / list_files). The model decides
 * which tool(s) to call and in what order — we do not hardcode a retrieval
 * pipeline. Text is streamed as `token` events; each tool call/result is
 * surfaced as `tool_call` / `tool_result` events for the UI's working-status
 * chips and agent-log panel.
 */
export async function runAgentTurn(params: AgentTurnParams): Promise<AgentTurnResult> {
  const { workspaceId, system, history, userMessage, sse } = params;
  const ctx: ToolContext = { workspaceId };

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: userMessage },
  ];

  let text = '';
  const citations: Citation[] = [];
  const toolCalls: ToolCallRecord[] = [];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system,
      messages,
      tools: toolDefinitions,
    });

    stream.on('text', (delta) => {
      text += delta;
      sse.send('token', { text: delta });
    });

    const msg = await stream.finalMessage();
    // Preserve the full assistant content (incl. thinking + tool_use blocks).
    messages.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason !== 'tool_use') break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue;
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
  }

  return { text, citations: dedupe(citations), toolCalls };
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
