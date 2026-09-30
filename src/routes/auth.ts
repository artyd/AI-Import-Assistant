import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { verifyPassword } from '../auth/passwords.js';
import { signToken } from '../auth/jwt.js';
import { authenticate } from '../auth/hook.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { issueSseTicket } from '../auth/sseTicket.js';
import { config } from '../config.js';
import {
  loginRateLimit,
  isEmailLocked,
  recordLoginFailure,
  clearLoginFailures,
  codeLoginRateLimit,
  isCodeLoginLocked,
  recordCodeFailure,
} from '../auth/loginThrottle.js';

const codeSchema = z.object({ code: z.string().min(1).max(32) });

/** PIN login is on when a 6–8 digit PIN is configured. */
function codeLoginEnabled(): boolean {
  return /^\d{6,8}$/.test(config.ACCESS_CODE);
}

if (config.ACCESS_CODE && !codeLoginEnabled()) {
  // eslint-disable-next-line no-console
  console.warn('ACCESS_CODE ignored: the PIN must be 6–8 digits.');
}

/** Constant-time PIN comparison (hash first so lengths always match). */
function codeMatches(input: string): boolean {
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(config.ACCESS_CODE).digest();
  return timingSafeEqual(a, b);
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/auth/login  — the only unauthenticated endpoint.
  // Throttled per client IP (route rate limit) AND per target email (lockout
  // after repeated failures), so neither one-IP guessing nor a distributed
  // attack on one account works. trustProxy makes req.ip the real client.
  app.post('/api/auth/login', { config: { rateLimit: loginRateLimit } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const { email, password } = parsed.data;
    if (isEmailLocked(email)) {
      return reply.code(429).send({ error: 'too_many_attempts' });
    }

    const { rows } = await query<UserRow>(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    const user = rows[0];
    // Constant-ish response regardless of whether the email exists.
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      recordLoginFailure(email);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    clearLoginFailures(email);

    const token = signToken({ sub: user.id, email: user.email });
    return reply.send({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  });

  // GET /api/auth/methods — which login methods the UI should offer (public).
  app.get('/api/auth/methods', async (_req, reply) => {
    const enabled = codeLoginEnabled();
    return reply.send({ codeLogin: enabled, codeLength: enabled ? config.ACCESS_CODE.length : null });
  });

  // POST /api/auth/login-code — quick shared PIN login. Guarded
  // by a per-IP limit (5 / 15 min) AND a global lockout (ACCESS_CODE_MAX_FAILURES
  // wrong PINs in 24 h from any IPs → PIN login off for 24 h), so neither one
  // client nor a botnet can enumerate the PIN space.
  app.post('/api/auth/login-code', { config: { rateLimit: codeLoginRateLimit } }, async (req, reply) => {
    if (!codeLoginEnabled()) return reply.code(404).send({ error: 'code_login_disabled' });
    if (isCodeLoginLocked(config.ACCESS_CODE_MAX_FAILURES)) {
      return reply.code(429).send({ error: 'code_login_locked' });
    }
    const parsed = codeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!codeMatches(parsed.data.code)) {
      recordCodeFailure();
      return reply.code(401).send({ error: 'invalid_code' });
    }
    // The PIN opens ACCESS_CODE_EMAIL's account when set, otherwise the main
    // (first-created) account — one shared team code, no email needed.
    const target = config.ACCESS_CODE_EMAIL.trim().toLowerCase();
    const { rows } = target
      ? await query<{ id: string; email: string; name: string }>(
          'SELECT id, email, name FROM users WHERE email = $1',
          [target],
        )
      : await query<{ id: string; email: string; name: string }>(
          'SELECT id, email, name FROM users ORDER BY created_at ASC LIMIT 1',
        );
    const user = rows[0];
    if (!user) return reply.code(401).send({ error: 'no_user' });
    const token = signToken({ sub: user.id, email: user.email });
    return reply.send({ token, user: { id: user.id, email: user.email, name: user.name } });
  });

  // POST /api/auth/sse-ticket — one-time 60 s ticket for an EventSource URL.
  app.post('/api/auth/sse-ticket', { preHandler: authenticate }, async (req, reply) => {
    return reply.send({ ticket: issueSseTicket(req.user!) });
  });

  // POST /api/auth/logout — JWT is stateless; client discards the token.
  app.post('/api/auth/logout', { preHandler: authenticate }, async (_req, reply) => {
    return reply.send({ ok: true });
  });

  // GET /api/auth/me
  app.get('/api/auth/me', { preHandler: authenticate }, async (req, reply) => {
    const { rows } = await query<{ id: string; email: string; name: string }>(
      'SELECT id, email, name FROM users WHERE id = $1',
      [req.user!.sub],
    );
    const user = rows[0];
    if (!user) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ user });
  });
}
