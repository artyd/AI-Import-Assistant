import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/hook.js';
import { listNotifications } from '../services/notifications.js';

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/notifications — current user's notifications (read-only for now;
  // mark-read + live push land in a later phase).
  app.get('/api/notifications', async (req, reply) => {
    const notifications = await listNotifications(req.user!.sub);
    return reply.send({ notifications });
  });
}
