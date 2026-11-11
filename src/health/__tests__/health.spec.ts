import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../db/pool.js', () => ({ query: vi.fn() }));
vi.mock('../../lib/queue/connection.js', () => ({ createRedis: vi.fn() }));

import { healthRoutes } from '../health.routes.js';

async function call(db: () => Promise<unknown>, redis: () => Promise<unknown>) {
  const app = Fastify();
  await app.register(healthRoutes, { deps: { db, redis } });
  return app.inject('/health/ready');
}

describe('GET /health/ready', () => {
  it('200 when both are up', async () => {
    const res = await call(async () => 1, async () => 'PONG');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
  });
  it('503 naming the failed part', async () => {
    const res = await call(async () => 1, async () => Promise.reject(new Error('x')));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ db: 'ok', redis: 'fail' });
  });
});
