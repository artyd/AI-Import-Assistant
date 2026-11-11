import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCounters } from './fakeCounters.js';

const create = vi.fn(async (..._args: unknown[]) => ({ content: [{ type: 'text', text: '- AI digest bullet' }] }));

vi.mock('../../lib/config.js', () => ({
  config: {
    REDIS_URL: 'redis://x',
    LOGIST_DIGEST_MODEL: 'test-model',
    MCP_DAILY_PER_IP: 3000,
    MCP_AI_DAILY_CALLS: 300,
    MCP_AI_DAILY_PER_IP: 60,
  },
}));
vi.mock('../../lib/anthropic/client.js', () => ({
  anthropic: { messages: { create: (...a: unknown[]) => create(...a) } },
}));
vi.mock('../../lib/anthropic/limiter.js', () => ({ runWithAnthropicLimit: (fn: () => unknown) => fn() }));
vi.mock('../../lib/queue/connection.js', () => ({
  createRedis: () => ({ get: async () => null, set: async () => 'OK' }),
}));
vi.mock('../../customs/logist/index.js', () => ({
  uktzedLookup: vi.fn(async () => ({
    code: '2941',
    common: 'RAWDATA '.repeat(2500), // 20 000 chars → needs the AI digest
    tabs: [],
    source: 'https://qdpro.com.ua/x',
  })),
}));
vi.mock('../../agent/tools.js', async () => {
  const { runUktzedLookup } = await import('../../agent/tools/logist.js');
  return {
    logistTools: () => [
      { name: 'uktzed_lookup_code', description: 'lookup', input_schema: { type: 'object', properties: {} } },
    ],
    executeTool: (_name: string, args: unknown) => runUktzedLookup(args),
  };
});
vi.mock('../../customs/drugRegistry.js', () => ({ getRegistration: vi.fn(async () => null) }));
vi.mock('../../agent/tools/hub.js', () => ({
  publicTrackTool: { name: 'track_by_number', description: 't', input_schema: { type: 'object', properties: {} } },
  portStatusTool: { name: 'get_port_status', description: 'p', input_schema: { type: 'object', properties: {} } },
}));
vi.mock('../../agent/tools/sheet.js', () => ({ sheetTools: () => [] }));

const { handleMcpPayload } = await import('../server.js');
const { McpLimiter } = await import('../limits.js');

const NOTE = 'ШІ-зведення на сьогодні недоступне';
let id = 0;

type Reply = {
  result?: { content: { text: string }[]; isError: boolean };
  error?: { code: number; message: string };
};

async function lookup(limiter: InstanceType<typeof McpLimiter>, ip: string, args: unknown = { code: '2941' }) {
  return (await handleMcpPayload(
    { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'uktzed_lookup_code', arguments: args } },
    { ip, limiter },
  )) as Reply;
}

function make(cfg: Partial<{ aiDailyCalls: number; aiDailyPerIp: number }> = {}, counters = new FakeCounters()) {
  const limiter = new McpLimiter(
    counters,
    { burstPerMinute: 120, dailyPerIp: 3000, aiDailyCalls: 300, aiDailyPerIp: 60, ...cfg },
    Date.now,
    () => undefined,
  );
  return { limiter, counters };
}

beforeEach(() => create.mockClear());

describe('MCP AI budget on uktzed_lookup_code', () => {
  it('uses the AI digest while the budget lasts', async () => {
    const { limiter } = make();
    const res = await lookup(limiter, '1.1.1.1');
    expect(create).toHaveBeenCalled();
    expect(res.result!.content[0]!.text).toContain('AI digest bullet');
    expect(res.result!.content[0]!.text).not.toContain(NOTE);
  });

  it('answers with the raw data and a note once the global budget is spent', async () => {
    const { limiter } = make({ aiDailyCalls: 1 });
    await lookup(limiter, '1.1.1.1');
    create.mockClear();
    const res = await lookup(limiter, '2.2.2.2');
    expect(create).not.toHaveBeenCalled();
    expect(res.result!.isError).toBe(false);
    const text = res.result!.content[0]!.text;
    expect(text).toContain(NOTE);
    expect(text).toContain('RAWDATA');
    expect(text).not.toContain('AI digest bullet');
  });

  it('applies the per-IP AI cap but still serves other IPs', async () => {
    const { limiter } = make({ aiDailyPerIp: 1 });
    await lookup(limiter, '1.1.1.1');
    create.mockClear();
    const capped = await lookup(limiter, '1.1.1.1');
    expect(create).not.toHaveBeenCalled();
    expect(capped.result!.content[0]!.text).toContain(NOTE);
    const other = await lookup(limiter, '3.3.3.3');
    expect(other.result!.content[0]!.text).toContain('AI digest bullet');
  });

  it('turns the AI digest off (fails closed) when Redis is down, but still answers', async () => {
    const counters = new FakeCounters();
    counters.down = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { limiter } = make({}, counters);
    const res = await lookup(limiter, '1.1.1.1');
    expect(create).not.toHaveBeenCalled();
    expect(res.result!.content[0]!.text).toContain(NOTE);
    expect(res.result!.content[0]!.text).toContain('RAWDATA');
  });
});

describe('MCP input limits', () => {
  it('rejects an oversized tool argument', async () => {
    const { limiter } = make();
    const res = await lookup(limiter, '1.1.1.1', { code: 'x'.repeat(201) });
    expect(res.error).toMatchObject({ code: -32602 });
    expect(create).not.toHaveBeenCalled();
  });

  it('returns a JSON-RPC error when a tool call times out', async () => {
    const { uktzedLookup } = await import('../../customs/logist/index.js');
    vi.mocked(uktzedLookup).mockImplementationOnce(() => new Promise(() => undefined));
    const { limiter } = make();
    const res = (await handleMcpPayload(
      { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'uktzed_lookup_code', arguments: { code: '2941' } } },
      { ip: '1.1.1.1', limiter, timeoutMs: 20 },
    )) as Reply;
    expect(res.error).toMatchObject({ code: -32001 });
  });

  it('rejects a batch of more than 20 at the handler too', async () => {
    const batch = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' }));
    expect(await handleMcpPayload(batch)).toMatchObject({ error: { code: -32600 } });
  });
});
