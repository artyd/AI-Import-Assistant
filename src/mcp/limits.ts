import { Redis } from 'ioredis';
import { config } from '../lib/config.js';

/**
 * Abuse and cost limits for the open MCP endpoint (ADR-0008, "Abuse and cost
 * limits (2026-11)").
 *
 * - Request limits (per-IP burst per minute + per-IP daily cap): fail OPEN — if
 *   Redis is down we keep serving and log a warning.
 * - AI budget (per-IP + global daily calls that spend the Anthropic key): fail
 *   CLOSED — if Redis is down the AI digest is switched off, so an outage can
 *   never open the wallet.
 *
 * All counting goes through the small `McpCounters` interface so tests can use an
 * in-memory fake.
 */

export interface McpCounters {
  /**
   * Atomically increments `key` and, when the key is new, sets it to expire at
   * `expireAtSec` (unix seconds). Returns the new value. May throw (Redis down).
   */
  incr(key: string, expireAtSec: number): Promise<number>;
}

export interface McpLimitConfig {
  burstPerMinute: number;
  dailyPerIp: number;
  aiDailyCalls: number;
  aiDailyPerIp: number;
}

export function mcpLimitConfigFromEnv(): McpLimitConfig {
  return {
    burstPerMinute: 120,
    dailyPerIp: config.MCP_DAILY_PER_IP,
    aiDailyCalls: config.MCP_AI_DAILY_CALLS,
    aiDailyPerIp: config.MCP_AI_DAILY_PER_IP,
  };
}

export type McpLimitEvent =
  | { type: 'ip_daily_cap'; ip: string; limit: number }
  | { type: 'ai_ip_daily_cap'; ip: string; limit: number }
  | { type: 'ai_global_budget'; percent: 80 | 100; used: number; limit: number };

/**
 * One warn-level log line per event; the limiter fires each event at most once
 * per UTC day (the Redis counter value is the "once" guard).
 */
export function onMcpLimitEvent(event: McpLimitEvent): void {
  console.warn('[mcp-limit]', JSON.stringify(event));
}

// ── Redis implementation ──────────────────────────────────────────────────────

// INCR + EXPIREAT in one script so the TTL can never be left unset.
const INCR_SCRIPT =
  "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIREAT', KEYS[1], ARGV[1]) end return c";

/**
 * A dedicated, fail-fast client: unlike the BullMQ connection it never queues or
 * retries commands forever, so a Redis outage costs a few ms, not a hung request.
 */
export function createRedisMcpCounters(url: string = config.REDIS_URL): McpCounters {
  let client: Redis | null = null;
  const get = (): Redis => {
    if (!client) {
      client = new Redis(url, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 1500,
        commandTimeout: 1500,
        retryStrategy: (times) => Math.min(times * 500, 5000),
      });
      client.on('error', () => undefined); // surfaced per command; avoid unhandled 'error'
    }
    return client;
  };
  return {
    async incr(key, expireAtSec) {
      const n = await get().eval(INCR_SCRIPT, 1, key, String(expireAtSec));
      return Number(n);
    },
  };
}

// ── Limiter ───────────────────────────────────────────────────────────────────

export type RequestVerdict =
  | { ok: true }
  | { ok: false; scope: 'burst' | 'daily'; retryAfterSec: number };

export interface AiGate {
  /** Resolves true when this call may spend Anthropic tokens. Decided once per tool call. */
  allow(): Promise<boolean>;
  /** True once `allow()` has answered false. */
  readonly skipped: boolean;
}

const DAY_MS = 86_400_000;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
function endOfUtcDaySec(now: number): number {
  return Math.floor(((Math.floor(now / DAY_MS) + 1) * DAY_MS) / 1000);
}

export class McpLimiter {
  private lastWarn = 0;

  constructor(
    private readonly counters: McpCounters,
    private readonly cfg: McpLimitConfig = mcpLimitConfigFromEnv(),
    private readonly now: () => number = Date.now,
    private readonly onEvent: (e: McpLimitEvent) => void = onMcpLimitEvent,
  ) {}

  private warnRedis(what: string, err: unknown): void {
    const t = this.now();
    if (t - this.lastWarn < 60_000) return;
    this.lastWarn = t;
    console.warn(`[mcp-limit] Redis unavailable (${what}): ${(err as Error).message}`);
  }

  /** Per-IP burst (per minute) and daily caps. Fails open. */
  async checkRequest(ip: string): Promise<RequestVerdict> {
    const t = this.now();
    try {
      const minute = Math.floor(t / 60_000);
      const burstEnd = (minute + 1) * 60;
      const burst = await this.counters.incr(`mcp:burst:${ip}:${minute}`, burstEnd + 5);
      if (burst > this.cfg.burstPerMinute) {
        return { ok: false, scope: 'burst', retryAfterSec: Math.max(1, burstEnd - Math.floor(t / 1000)) };
      }
      const day = utcDay(t);
      const daily = await this.counters.incr(`mcp:day:${day}:${ip}`, endOfUtcDaySec(t));
      if (daily > this.cfg.dailyPerIp) {
        if (daily === this.cfg.dailyPerIp + 1) this.onEvent({ type: 'ip_daily_cap', ip, limit: this.cfg.dailyPerIp });
        return { ok: false, scope: 'daily', retryAfterSec: Math.max(1, endOfUtcDaySec(t) - Math.floor(t / 1000)) };
      }
      return { ok: true };
    } catch (err) {
      this.warnRedis('request limits, failing open', err);
      return { ok: true };
    }
  }

  /** A gate for ONE tool call; the budget is charged only when `allow()` is asked. */
  aiGate(ip: string): AiGate {
    let decision: Promise<boolean> | null = null;
    const gate = {
      skipped: false,
      allow: (): Promise<boolean> => {
        decision ??= this.chargeAi(ip).then((ok) => {
          gate.skipped = !ok;
          return ok;
        });
        return decision;
      },
    };
    return gate;
  }

  /** Charges one AI call. Fails CLOSED. Per-IP is checked first so a noisy IP can't drain the global budget. */
  private async chargeAi(ip: string): Promise<boolean> {
    const t = this.now();
    const day = utcDay(t);
    const exp = endOfUtcDaySec(t);
    try {
      const perIp = await this.counters.incr(`mcp:ai:ip:${day}:${ip}`, exp);
      if (perIp > this.cfg.aiDailyPerIp) {
        if (perIp === this.cfg.aiDailyPerIp + 1) this.onEvent({ type: 'ai_ip_daily_cap', ip, limit: this.cfg.aiDailyPerIp });
        return false;
      }
      const used = await this.counters.incr(`mcp:ai:global:${day}`, exp);
      const limit = this.cfg.aiDailyCalls;
      const eighty = Math.ceil(limit * 0.8);
      if (used === eighty && eighty < limit) this.onEvent({ type: 'ai_global_budget', percent: 80, used, limit });
      if (used === limit) this.onEvent({ type: 'ai_global_budget', percent: 100, used, limit });
      return used <= limit;
    } catch (err) {
      this.warnRedis('AI budget, failing closed', err);
      return false;
    }
  }
}

let shared: McpLimiter | null = null;
/** Process-wide limiter on Redis; created lazily so importing the module opens nothing. */
export function getMcpLimiter(): McpLimiter {
  shared ??= new McpLimiter(createRedisMcpCounters());
  return shared;
}
