import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { authenticate } from '../auth/hook.js';

/** "anna.k@agroup95.com" → "an***@agroup95.com" (enough to recognise, not to harvest). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/users — minimal directory so a responsible_user_id can be chosen.
  // Other users' emails are masked (there is no team/role model yet, so every
  // account could otherwise harvest every address); the UI shows names.
  app.get('/api/users', async (req, reply) => {
    const { rows } = await query<{ id: string; email: string; name: string | null }>(
      'SELECT id, email, name FROM users ORDER BY name NULLS LAST, email',
    );
    const me = req.user!.sub;
    return reply.send({
      users: rows.map((u) => ({ ...u, email: u.id === me ? u.email : maskEmail(u.email) })),
    });
  });
}
