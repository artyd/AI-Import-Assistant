import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { verifyPassword } from '../auth/passwords.js';
import { signToken } from '../auth/jwt.js';
import { authenticate } from '../auth/hook.js';

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
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const { email, password } = parsed.data;

    const { rows } = await query<UserRow>(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    const user = rows[0];
    // Constant-ish response regardless of whether the email exists.
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const token = signToken({ sub: user.id, email: user.email });
    return reply.send({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
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
