import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { handleMcpPayload } from '../services/mcp/server.js';

/**
 * Штурман as an open MCP server: POST /api/mcp. No access token — it exposes
 * read-only reference lookups (plus the team-sheet tools when SHEET_ID is set —
 * see services/mcp/server.ts), and an auth challenge
 * makes claude.ai fall back to an OAuth sign-in we don't run. Abuse is bounded by
 * a per-IP rate limit. `/api/mcp/<anything>` is served too, so links issued while
 * the endpoint still took a personal token keep working.
 *
 * Stateless JSON-RPC; GET/DELETE → 405 (no server-initiated SSE stream, no sessions).
 */

// claude.ai calls arrive from Anthropic's shared egress IPs, so one bucket covers
// all of its users — keep the limit generous.
const MCP_RATE = { max: 120, timeWindow: '1 minute' };

async function serveMcp(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const out = await handleMcpPayload(req.body);
  if (out === null) return reply.code(202).send();
  return reply.header('Cache-Control', 'no-store').send(out);
}

function methodNotAllowed(_req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(405).header('Allow', 'POST').send({ error: 'method_not_allowed' });
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  const rl = { config: { rateLimit: MCP_RATE } };
  for (const url of ['/api/mcp', '/api/mcp/:legacyToken']) {
    app.post(url, rl, serveMcp);
    app.get(url, methodNotAllowed);
    app.delete(url, methodNotAllowed);
  }
}
