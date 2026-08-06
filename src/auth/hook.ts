import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken, type JwtClaims } from './jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtClaims;
  }
}

/**
 * preHandler that requires a valid Bearer token. Attaches request.user.
 * The frontend sends `Authorization: Bearer <jwt>`; a `token` cookie is also
 * accepted so the SSE EventSource (which cannot set headers) can authenticate.
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

  // Query param fallback for EventSource-based SSE clients.
  const q = (req.query as Record<string, unknown> | undefined)?.access_token;
  if (typeof q === 'string' && q.length > 0) return q;

  // Cookie fallback (`token=<jwt>`).
  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === 'token' && v.length) return decodeURIComponent(v.join('='));
    }
  }
  return null;
}
