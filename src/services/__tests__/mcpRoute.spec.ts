import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';

vi.mock('../mcp/server.js', () => ({
  handleMcpPayload: vi.fn(async (body: { id?: number }) =>
    body.id === undefined ? null : { jsonrpc: '2.0', id: body.id, result: {} },
  ),
}));

const { mcpRoutes } = await import('../../routes/mcp.js');

async function app() {
  const a = Fastify();
  await a.register(rateLimit, { global: false });
  await a.register(mcpRoutes);
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
});
