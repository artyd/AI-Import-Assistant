import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { authenticate } from '../auth/hook.js';

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/users — minimal directory so a responsible_user_id can be chosen.
  app.get('/api/users', async (_req, reply) => {
    const { rows } = await query('SELECT id, email, name FROM users ORDER BY email');
    return reply.send({ users: rows });
  });
}
