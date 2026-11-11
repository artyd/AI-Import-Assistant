import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { query } from '../db/pool.js';
import { createRedis } from '../lib/queue/connection.js';

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

export interface ReadyDeps {
  db: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

export async function checkReady(deps: ReadyDeps): Promise<{ ok: boolean; db: 'ok' | 'fail'; redis: 'ok' | 'fail' }> {
  const probe = (fn: () => Promise<unknown>): Promise<'ok' | 'fail'> =>
    withTimeout(fn(), CHECK_TIMEOUT_MS).then(
      () => 'ok' as const,
      () => 'fail' as const,
    );
  const [db, redis] = await Promise.all([probe(deps.db), probe(deps.redis)]);
  return { ok: db === 'ok' && redis === 'ok', db, redis };
}

export async function healthRoutes(app: FastifyInstance, opts: { deps?: ReadyDeps } = {}): Promise<void> {
  let redis: Redis | null = null;
  const deps: ReadyDeps = opts.deps ?? {
    db: () => query('select 1'),
    redis: () => {
      redis ??= createRedis();
      return redis.ping();
    },
  };
  app.addHook('onClose', async () => {
    redis?.disconnect();
  });

  // GET /health stays in server.ts, unchanged.
  app.get('/health/ready', async (_req, reply) => {
    const r = await checkReady(deps);
    const body = { status: r.ok ? 'ok' : 'unavailable', db: r.db, redis: r.redis };
    return reply.code(r.ok ? 200 : 503).send(body);
  });
}
