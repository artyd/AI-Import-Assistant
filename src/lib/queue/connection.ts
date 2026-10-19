import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by workers
 * (blocking commands). We use the same setting for the producer for simplicity.
 * Each Queue/Worker gets its own connection.
 */
export function createRedis(): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}
