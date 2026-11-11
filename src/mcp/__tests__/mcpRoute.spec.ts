import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { FakeCounters } from './fakeCounters.js';

vi.mock('../../lib/config.js', () => ({
  config: { REDIS_URL: 'redis://x', MCP_DAILY_PER_IP: 3000, MCP_AI_DAILY_CALLS: 300, MCP_AI_DAILY_PER_IP: 60 },
}));
vi.mock('../server.js', () => ({
  MCP_MAX_BATCH: 20,
  handleMcpPayload: vi.fn(async (body: { id?: number } | { id?: number }[]) =>
    Array.isArray(body)
      ? body.map((m) => ({ jsonrpc: '2.0', id: m.id, result: {} }))
      : body.id === undefined
        ? null
        : { jsonrpc: '2.0', id: body.id, result: {} },
  ),
}));

const { mcpRoutes } = await import('../mcp.routes.js');
const { McpLimiter } = await import('../limits.js');

const CFG = { burstPerMinute: 120, dailyPerIp: 3, aiDailyCalls: 300, aiDailyPerIp: 60 };

async function app(counters = new FakeCounters(), cfg = CFG) {
  const a = Fastify();
  await a.register(rateLimit, { global: false });
  const limiter = new McpLimiter(counters, cfg, Date.now, () => undefined);
  await a.register(mcpRoutes, { limiter });
  return a;
}

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('MCP route', () => {
  it('serves /api/mcp without any credentials', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/api/mcp', payload: ping });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 1, result: {} });
  });

  it('keeps old token links working', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/api/mcp/shm_old', payload: ping });
    expect(res.statusCode).toBe(200);
  });

  it('answers notifications with 202 and GET with 405', async () => {
    const a = await app();
    const note = await a.inject({ method: 'POST', url: '/api/mcp', payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    expect(note.statusCode).toBe(202);
    expect((await a.inject({ method: 'GET', url: '/api/mcp' })).statusCode).toBe(405);
  });

  it('answers 429 with Retry-After and a JSON-RPC error once the daily per-IP cap is spent', async () => {
    const a = await app();
    for (let i = 0; i < 3; i++) {
      expect((await a.inject({ method: 'POST', url: '/api/mcp', payload: ping })).statusCode).toBe(200);
    }
    const res = await a.inject({ method: 'POST', url: '/api/mcp', payload: ping });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32000, data: { limit: 'daily' } } });
  });

  it('answers 429 on the per-minute burst limit', async () => {
    const a = await app(new FakeCounters(), { ...CFG, burstPerMinute: 2, dailyPerIp: 1000 });
    await a.inject({ method: 'POST', url: '/api/mcp', payload: ping });
    await a.inject({ method: 'POST', url: '/api/mcp', payload: ping });
    const res = await a.inject({ method: 'POST', url: '/api/mcp', payload: ping });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { data: { limit: 'burst' } } });
  });

  it('rejects a batch of more than 20 calls', async () => {
    const batch = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' }));
    const res = await (await app()).inject({ method: 'POST', url: '/api/mcp', payload: batch });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: -32600 } });
  });

  it('accepts a batch of exactly 20', async () => {
    const batch = Array.from({ length: 20 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' }));
    expect((await (await app()).inject({ method: 'POST', url: '/api/mcp', payload: batch })).statusCode).toBe(200);
  });

  it('rejects a body over 256 KB with 413', async () => {
    const big = { jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(300 * 1024) } };
    const res = await (await app()).inject({ method: 'POST', url: '/api/mcp', payload: big });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } });
  });

  it('keeps serving (fails open) when Redis is down', async () => {
    const counters = new FakeCounters();
    counters.down = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await (await app(counters)).inject({ method: 'POST', url: '/api/mcp', payload: ping });
    expect(res.statusCode).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
