import { beforeEach, describe, expect, it, vi } from 'vitest';

// A scripted model: each call pops the next reply {content, stop_reason}; text blocks stream as deltas.
const replies: { content: unknown[]; stop_reason: string }[] = [];
const requests: { messages: unknown[]; tool_choice?: unknown }[] = [];

vi.mock('../../lib/anthropic/client.js', () => ({
  MODEL: 'claude-test',
  anthropic: {
    beta: {
      messages: {
        stream: (req: { messages: unknown[]; tool_choice?: unknown }) => {
          requests.push({ messages: JSON.parse(JSON.stringify(req.messages)), tool_choice: req.tool_choice });
          const reply = replies.shift();
          if (!reply) throw new Error('no scripted reply');
          const handlers: Record<string, ((t: string) => void)[]> = {};
          return {
            on(ev: string, cb: (t: string) => void) {
              (handlers[ev] ??= []).push(cb);
              return this;
            },
            async finalMessage() {
              for (const b of reply.content as { type: string; text?: string }[]) {
                if (b.type === 'text') for (const cb of handlers.text ?? []) cb(b.text ?? '');
                for (const cb of handlers.contentBlock ?? []) cb('');
              }
              return { ...reply, usage: { input_tokens: 10, output_tokens: 5 } };
            },
          };
        },
      },
    },
  },
}));
vi.mock('../../lib/config.js', () => ({
  config: {
    AGENT_MAX_TOKENS: 1000,
    AGENT_EFFORT: 'high',
    AGENT_CONTEXT_TOKENS: 1_000_000,
    AGENT_CLEAR_TRIGGER_TOKENS: 500_000,
    AGENT_CLEAR_KEEP_TOOL_USES: 8,
    AGENT_FACT_CHECK: 'log',
  },
}));
vi.mock('../../lib/alerts.js', () => ({ reportAnthropicError: () => false }));
vi.mock('../tools.js', () => ({
  toolDefinitions: [{ name: 'read_file', description: '', input_schema: { type: 'object', properties: {} } }],
  executeTool: vi.fn(async () => ({
    result: 'Файл: inv.pdf\nTotal 12 345,67 USD, container MSKU1234567',
    summary: 'Прочитано: inv.pdf',
    citations: [],
  })),
}));
const loadShipmentCorpus = vi.fn(async () => [{ file: 'other.pdf', pages: [{ page: 1, text: 'Weight 25 000 kg' }] }]);
vi.mock('../tools/verify.js', () => ({ loadShipmentCorpus: (...a: unknown[]) => loadShipmentCorpus(...(a as [])) }));

import { runAgentTurn } from '../loop.js';
import { executeTool } from '../tools.js';
import { config } from '../../lib/config.js';

const sse = () => {
  const events: { ev: string; data: unknown }[] = [];
  return { events, send: (ev: string, data: unknown) => void events.push({ ev, data }) } as never as {
    events: { ev: string; data: any }[];
    send: (ev: string, data: unknown) => void;
  };
};

const toolUse = { content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'inv.pdf' } }], stop_reason: 'tool_use' };
const answer = (t: string) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
const run = (s: ReturnType<typeof sse>) =>
  runAgentTurn({ workspaceId: 'ws-1', system: 'sys', history: [], userMessage: 'Що в інвойсі?', sse: s as never });

beforeEach(() => {
  replies.length = 0;
  requests.length = 0;
  loadShipmentCorpus.mockClear();
  (config as { AGENT_FACT_CHECK: string }).AGENT_FACT_CHECK = 'log';
});

describe('post-answer fact check in the loop', () => {
  it('log mode: supported figures pass, an unsupported one lands in usage; text and wire events are untouched', async () => {
    replies.push(toolUse, answer('Сума 12 345,67 USD, вага 25 000 кг, контейнер MSKU7654321.'));
    const s = sse();
    const r = await run(s);
    expect(r.usage.unsupportedFigures).toEqual(['MSKU7654321']);
    expect(r.text).toBe('Сума 12 345,67 USD, вага 25 000 кг, контейнер MSKU7654321.');
    expect(new Set(s.events.map((e) => e.ev))).toEqual(new Set(['token', 'tool_call', 'tool_result']));
    expect(requests).toHaveLength(2); // no corrective call in log mode
  });

  it('a fully supported answer has no unsupportedFigures key', async () => {
    replies.push(toolUse, answer('Сума 12 345,67 USD.'));
    const r = await run(sse());
    expect('unsupportedFigures' in r.usage).toBe(false);
    expect(loadShipmentCorpus).not.toHaveBeenCalled(); // tool results were enough
  });

  it('off mode does nothing', async () => {
    (config as { AGENT_FACT_CHECK: string }).AGENT_FACT_CHECK = 'off';
    replies.push(toolUse, answer('Контейнер MSKU7654321.'));
    const r = await run(sse());
    expect('unsupportedFigures' in r.usage).toBe(false);
  });

  it('correct mode: one «Уточнення:» continuation, tool_choice none, merged into the last assistant message', async () => {
    (config as { AGENT_FACT_CHECK: string }).AGENT_FACT_CHECK = 'correct';
    replies.push(toolUse, answer('Контейнер MSKU7654321.'), answer('Номер контейнера не підтверджено, правильний MSKU1234567.'));
    const s = sse();
    const r = await run(s);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.tool_choice).toEqual({ type: 'none' });
    expect(r.text).toBe('Контейнер MSKU7654321.\n\nУточнення: Номер контейнера не підтверджено, правильний MSKU1234567.');
    const last = r.turnBlocks[r.turnBlocks.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(JSON.stringify(last.content)).toContain('Уточнення:');
    // roles alternate: no two assistant messages in a row
    for (let i = 1; i < r.turnBlocks.length; i++) expect(r.turnBlocks[i]!.role).not.toBe(r.turnBlocks[i - 1]!.role);
  });

  it('correct mode skips the continuation when verify_facts was used', async () => {
    (config as { AGENT_FACT_CHECK: string }).AGENT_FACT_CHECK = 'correct';
    const verify = { content: [{ type: 'tool_use', id: 't2', name: 'verify_facts', input: { facts: [{ value: 'x' }] } }], stop_reason: 'tool_use' };
    replies.push(verify, answer('Контейнер MSKU7654321.'));
    const r = await run(sse());
    expect(requests).toHaveLength(2);
    expect(r.usage.unsupportedFigures).toEqual(['MSKU7654321']);
  });
});

describe('tool calls of one step', () => {
  const twoReads = {
    content: [
      { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a.pdf' } },
      { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b.pdf' } },
    ],
    stop_reason: 'tool_use',
  };

  it('read-only calls run in parallel; results keep the call order', async () => {
    (config as { AGENT_FACT_CHECK: string }).AGENT_FACT_CHECK = 'off';
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(executeTool).mockImplementation(async (_name, input) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const path = String((input as { path: string }).path);
      await new Promise((r) => setTimeout(r, path === 'a.pdf' ? 30 : 5));
      inFlight--;
      return { result: `text of ${path}`, summary: `Прочитано: ${path}`, citations: [] };
    });
    replies.push(twoReads, answer('**Готово.**'));
    const s = sse();
    const r = await run(s);
    expect(maxInFlight).toBe(2);
    expect(s.events.filter((e) => e.ev === 'tool_call')).toHaveLength(2);
    expect(r.toolCalls.map((c) => c.summary)).toEqual(['Прочитано: a.pdf', 'Прочитано: b.pdf']);
    const results = (requests[1]!.messages.at(-1) as { content: { tool_use_id: string; content: string }[] }).content;
    expect(results.map((b) => b.tool_use_id)).toEqual(['a', 'b']);
    expect(results[0]!.content).toBe('text of a.pdf');
  });
});
