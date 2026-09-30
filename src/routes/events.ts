import type { FastifyInstance } from 'fastify';
import { authenticateSse } from '../auth/hook.js';
import { getOwnedWorkspace } from '../services/workspaceAccess.js';
import { SseStream } from '../sse/sse.js';
import { subscribeFileStatus } from '../events/fileStatus.js';

/**
 * Lightweight per-workspace event channel (SSE). Currently forwards live file
 * indexing-status transitions so the file-tree dots update in real time. GET so
 * the browser's native EventSource can consume it (auth via a one-time ?ticket=).
 */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/events',
    { preHandler: authenticateSse },
    async (req, reply) => {
      // Track disconnects from the very start: a client that leaves during the
      // ownership lookup used to leak a Redis subscriber + a 15 s interval.
      let closed = false;
      reply.raw.on('close', () => {
        closed = true;
      });

      const ws = await getOwnedWorkspace(req.user!.sub, req.params.id);
      if (!ws) return reply.code(404).send({ error: 'not_found' });
      if (closed || req.raw.destroyed) return;

      const sse = new SseStream(req, reply);
      const unsubscribe = subscribeFileStatus(ws.id, (event) => {
        sse.send('file_status', event);
      });
      const heartbeat = setInterval(() => sse.ping(), 15_000);

      const cleanup = (): void => {
        clearInterval(heartbeat);
        void unsubscribe();
        sse.close();
      };
      if (closed || req.raw.destroyed) cleanup();
      else reply.raw.on('close', cleanup);
    },
  );
}
