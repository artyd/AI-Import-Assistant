import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../auth/hook.js';
import { getMcpTokenStatus, issueMcpToken, resolveMcpToken, revokeMcpToken } from '../services/mcp/tokens.js';
import { handleMcpPayload } from '../services/mcp/server.js';

/**
 * Штурман as an MCP server.
 *
 * - Token management (signed-in user, JWT): GET/POST/DELETE /api/mcp-token —
 *   status / issue-or-rotate (raw token returned once) / revoke.
 * - The MCP endpoint itself: POST /api/mcp/<token> (connector URL with the token
 *   embedded — what Claude.ai/Desktop custom connectors accept), or POST /api/mcp
 *   with `Authorization: Bearer <token>`. Stateless JSON-RPC; GET/DELETE → 405
 *   (no server-initiated SSE stream, no sessions).
 */

const MCP_RATE = { max: 60, timeWindow: '1 minute' };

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice('Bearer '.length).trim() : '';
}

function pathToken(req: FastifyRequest): string {
  return String((req.params as { token?: unknown } | undefined)?.token ?? '');
}

async function serveMcp(req: FastifyRequest, reply: FastifyReply, token: string): Promise<FastifyReply> {
  const userId = token ? await resolveMcpToken(token) : null;
  if (!userId) {
    return reply.code(401).send({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Invalid or revoked Shturman MCP token — get a new link in Shturman.' },
    });
  }
  const out = await handleMcpPayload(req.body);
  if (out === null) return reply.code(202).send();
  return reply.header('Cache-Control', 'no-store').send(out);
}

function methodNotAllowed(_req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(405).header('Allow', 'POST').send({ error: 'method_not_allowed' });
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // ── token management (in-app) ────────────────────────────────────────────
  app.get('/api/mcp-token', { preHandler: authenticate }, async (req, reply) => {
    return reply.send(await getMcpTokenStatus(req.user!.sub));
  });

  app.post(
    '/api/mcp-token',
    { preHandler: authenticate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { token, status } = await issueMcpToken(req.user!.sub);
      return reply.header('Cache-Control', 'no-store').send({ ...status, token, path: `/api/mcp/${token}` });
    },
  );

  app.delete('/api/mcp-token', { preHandler: authenticate }, async (req, reply) => {
    await revokeMcpToken(req.user!.sub);
    return reply.send(await getMcpTokenStatus(req.user!.sub));
  });

  // ── the MCP endpoint ─────────────────────────────────────────────────────
  const tokenRate = (req: FastifyRequest): string => pathToken(req) || bearer(req) || req.ip;
  const rl = { config: { rateLimit: { ...MCP_RATE, keyGenerator: tokenRate } } };

  app.post('/api/mcp/:token', rl, (req, reply) => serveMcp(req, reply, pathToken(req)));
  app.post('/api/mcp', rl, (req, reply) => serveMcp(req, reply, bearer(req)));
  for (const url of ['/api/mcp', '/api/mcp/:token']) {
    app.get(url, methodNotAllowed);
    app.delete(url, methodNotAllowed);
  }
}
