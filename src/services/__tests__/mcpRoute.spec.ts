import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';

vi.mock('../mcp/tokens.js', () => ({
  resolveMcpToken: vi.fn(async (t: string) => (t === 'shm_good' ? 'user-1' : null)),
  getMcpTokenStatus: vi.fn(),
  issueMcpToken: vi.fn(),
  revokeMcpToken: vi.fn(),
}));
vi.mock('../mcp/server.js', () => ({
  handleMcpPayload: vi.fn(async (body: { id?: number }) =>
    body.id === undefined ? null : { jsonrpc: '2.0', id: body.id, result: {} },
  ),
}));
vi.mock('../../auth/hook.js', () => ({ authenticate: vi.fn() }));

const { mcpRoutes } = await import('../../routes/mcp.js');

async function app() {
  const a = Fastify();
  await a.register(rateLimit, { global: false });
  await a.register(mcpRoutes);
  return a;
}

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('MCP route', () => {
  it('serves a valid path token', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/api/mcp/shm_good', payload: ping });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 1, result: {} });
  });

  it('accepts the token as a Bearer header', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: 'Bearer shm_good' },
      payload: ping,
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects unknown or missing tokens with 401', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/api/mcp/shm_bad', payload: ping })).statusCode).toBe(401);
    expect((await a.inject({ method: 'POST', url: '/api/mcp', payload: ping })).statusCode).toBe(401);
  });

  it('answers notifications with 202 and GET with 405', async () => {
    const a = await app();
    const note = await a.inject({ method: 'POST', url: '/api/mcp/shm_good', payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    expect(note.statusCode).toBe(202);
    expect((await a.inject({ method: 'GET', url: '/api/mcp/shm_good' })).statusCode).toBe(405);
  });
});
