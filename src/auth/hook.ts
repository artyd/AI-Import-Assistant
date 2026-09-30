import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken, type JwtClaims } from './jwt.js';
import { consumeSseTicket } from './sseTicket.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtClaims;
  }
}

/**
 * preHandler that requires a valid Bearer token. Attaches request.user.
 * Header ONLY — the old `?access_token=` query and `token` cookie fallbacks were
 * accepted on every route (JWT leaked into logs; cookie auth without CSRF
 * protection). EventSource routes use `authenticateSse` + a one-time ticket.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    await reply.code(401).send({ error: 'unauthorized', message: 'Missing bearer token' });
    return;
  }
  try {
    req.user = verifyToken(token);
  } catch {
    await reply.code(401).send({ error: 'unauthorized', message: 'Invalid or expired token' });
  }
}

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  return null;
}

/**
 * preHandler for SSE-over-GET (EventSource) routes: a Bearer header, or a
 * single-use `?ticket=` minted by POST /api/auth/sse-ticket (60 s).
 */
export async function authenticateSse(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ticket = (req.query as Record<string, unknown> | undefined)?.ticket;
  if (typeof ticket === 'string' && ticket.length > 0) {
    const claims = consumeSseTicket(ticket);
    if (claims) {
      req.user = claims;
      return;
    }
    await reply.code(401).send({ error: 'unauthorized', message: 'Invalid or expired ticket' });
    return;
  }
  return authenticate(req, reply);
}
