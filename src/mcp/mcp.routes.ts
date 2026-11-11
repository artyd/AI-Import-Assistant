import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getMcpLimiter, type McpLimiter } from './limits.js';
import { handleMcpPayload, MCP_MAX_BATCH } from './server.js';

/**
 * Штурман as an open MCP server: POST /api/mcp. No access token — it exposes
 * read-only reference lookups (plus the team-sheet tools when SHEET_ID is set —
 * see mcp/server.ts), and an auth challenge
 * makes claude.ai fall back to an OAuth sign-in we don't run. Abuse and cost are
 * bounded by Redis-backed limits (mcp/limits.ts, ADR-0008): a generous per-IP
 * burst + daily cap, a daily budget for calls that spend our Anthropic key,
 * a 256 KB body, a 20-call batch and a per-call timeout.
 * `/api/mcp/<anything>` is served too, so links issued while
 * the endpoint still took a personal token keep working.
 *
 * Stateless JSON-RPC; GET/DELETE → 405 (no server-initiated SSE stream, no sessions).
 */

export const MCP_BODY_LIMIT = 256 * 1024;

type RpcError = { jsonrpc: '2.0'; id: null; error: { code: number; message: string; data?: unknown } };

function rpcError(code: number, message: string, data?: unknown): RpcError {
  return { jsonrpc: '2.0', id: null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export interface McpRoutesOptions {
  /** Test seam: defaults to the Redis-backed limiter. */
  limiter?: McpLimiter;
}

function methodNotAllowed(_req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(405).header('Allow', 'POST').send({ error: 'method_not_allowed' });
}

export async function mcpRoutes(app: FastifyInstance, opts: McpRoutesOptions = {}): Promise<void> {
  const limiter = (): McpLimiter => opts.limiter ?? getMcpLimiter();

  // Errors raised before the handler (oversized / malformed body) get a
  // JSON-RPC-shaped body too, so MCP clients can show them.
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status === 413) return reply.code(413).send(rpcError(-32600, 'Запит завеликий (макс. 256 КБ).'));
    if (status === 400) return reply.code(400).send(rpcError(-32700, 'Некоректний JSON.'));
    return reply.code(status >= 400 && status < 600 ? status : 500).send(rpcError(-32603, 'Internal error'));
  });

  // Runs before body parsing, so floods are counted (and cut) cheaply.
  const limit = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const v = await limiter().checkRequest(req.ip);
    if (v.ok) return undefined;
    const message =
      v.scope === 'burst'
        ? 'Забагато запитів за хвилину. Зачекайте і повторіть.'
        : 'Добовий ліміт запитів для вашої адреси вичерпано. Спробуйте завтра (о 00:00 UTC лічильник скидається).';
    return reply
      .code(429)
      .header('Retry-After', String(v.retryAfterSec))
      .send(rpcError(-32000, message, { limit: v.scope, retryAfterSec: v.retryAfterSec }));
  };

  async function serveMcp(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    if (Array.isArray(req.body) && req.body.length > MCP_MAX_BATCH) {
      return reply.code(400).send(rpcError(-32600, `Забагато викликів у пакеті (макс. ${MCP_MAX_BATCH}).`));
    }
    const out = await handleMcpPayload(req.body, { ip: req.ip, limiter: limiter() });
    if (out === null) return reply.code(202).send();
    return reply.header('Cache-Control', 'no-store').send(out);
  }

  for (const url of ['/api/mcp', '/api/mcp/:legacyToken']) {
    app.post(url, { bodyLimit: MCP_BODY_LIMIT, onRequest: limit }, serveMcp);
    app.get(url, methodNotAllowed);
    app.delete(url, methodNotAllowed);
  }
}
