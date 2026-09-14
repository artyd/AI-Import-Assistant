import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { verifyToken } from '../auth/jwt.js';

/**
 * Shared per-user rate-limit config for the chat SSE endpoints (supply / normal /
 * consolidated). Bounds Anthropic cost from runaway usage. The rate-limit
 * onRequest hook runs before the auth preHandler, so req.user isn't set yet —
 * decode the JWT here to key per-user, falling back to IP.
 */
export const chatRateLimitConfig = {
  rateLimit: {
    max: config.CHAT_RATE_MAX,
    timeWindow: config.CHAT_RATE_WINDOW,
    keyGenerator: (req: FastifyRequest): string => {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        try {
          return verifyToken(header.slice('Bearer '.length).trim()).sub;
        } catch {
          /* fall through to IP */
        }
      }
      return req.ip;
    },
  },
} as const;
