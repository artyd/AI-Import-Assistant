import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { SseStream } from '../sse/sse.js';
import { subscribeFileStatus } from '../events/fileStatus.js';

/**
 * Lightweight per-workspace event channel (SSE). Currently forwards live file
 * indexing-status transitions so the file-tree dots update in real time. GET so
 * the browser's native EventSource can consume it (auth via ?access_token=).
 */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/events',
    { preHandler: authenticate },
    async (req, reply) => {
      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });

      const sse = new SseStream(req, reply);
      const unsubscribe = subscribeFileStatus(ws.id, (event) => {
        sse.send('file_status', event);
      });
      const heartbeat = setInterval(() => sse.ping(), 15_000);

      req.raw.on('close', () => {
        clearInterval(heartbeat);
        void unsubscribe();
        sse.close();
      });
    },
  );
}
