import { describe, expect, it, vi } from 'vitest';
import { FakeCounters } from './fakeCounters.js';
import type { McpLimitEvent } from '../limits.js';

vi.mock('../../lib/config.js', () => ({
  config: { REDIS_URL: 'redis://x', MCP_DAILY_PER_IP: 3000, MCP_AI_DAILY_CALLS: 300, MCP_AI_DAILY_PER_IP: 60 },
}));

const { McpLimiter } = await import('../limits.js');

const CFG = { burstPerMinute: 120, dailyPerIp: 3, aiDailyCalls: 10, aiDailyPerIp: 4 };

function make(cfg = CFG, counters = new FakeCounters(), t = { now: Date.UTC(2026, 10, 11, 12, 0, 0) }) {
  const events: McpLimitEvent[] = [];
  const limiter = new McpLimiter(counters, cfg, () => t.now, (e) => events.push(e));
  return { limiter, counters, events, t };
}

describe('McpLimiter requests', () => {
  it('blocks the IP over its daily cap and logs the event once', async () => {
    const { limiter, events } = make();
    for (let i = 0; i < 3; i++) expect((await limiter.checkRequest('1.1.1.1')).ok).toBe(true);
    const v = await limiter.checkRequest('1.1.1.1');
    expect(v).toMatchObject({ ok: false, scope: 'daily' });
    await limiter.checkRequest('1.1.1.1');
    expect(events).toEqual([{ type: 'ip_daily_cap', ip: '1.1.1.1', limit: 3 }]);
    expect((await limiter.checkRequest('2.2.2.2')).ok).toBe(true);
  });

  it('resets on the next UTC day', async () => {
    const { limiter, t } = make();
    for (let i = 0; i < 4; i++) await limiter.checkRequest('1.1.1.1');
    t.now += 86_400_000;
    expect((await limiter.checkRequest('1.1.1.1')).ok).toBe(true);
  });

  it('fails open when the counters are down', async () => {
    const { limiter, counters } = make();
    counters.down = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await limiter.checkRequest('1.1.1.1')).ok).toBe(true);
  });
});

describe('McpLimiter AI budget', () => {
  it('stops one IP at its AI cap without touching the global budget', async () => {
    const { limiter, counters } = make();
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push(await limiter.aiGate('1.1.1.1').allow());
    expect(results).toEqual([true, true, true, true, false, false]);
    expect(counters.values.get('mcp:ai:global:2026-11-11')).toBe(4);
  });

  it('stops all IPs at the global budget and reports 80 % and 100 % once each', async () => {
    const { limiter, events } = make({ ...CFG, aiDailyPerIp: 100 });
    const results: boolean[] = [];
    for (let i = 0; i < 12; i++) results.push(await limiter.aiGate(`10.0.0.${i}`).allow());
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(results.slice(10)).toEqual([false, false]);
    expect(events).toEqual([
      { type: 'ai_global_budget', percent: 80, used: 8, limit: 10 },
      { type: 'ai_global_budget', percent: 100, used: 10, limit: 10 },
    ]);
  });

  it('charges once per gate however often allow() is asked', async () => {
    const { limiter, counters } = make();
    const gate = limiter.aiGate('1.1.1.1');
    await gate.allow();
    await gate.allow();
    expect(counters.values.get('mcp:ai:global:2026-11-11')).toBe(1);
  });

  it('fails closed when the counters are down', async () => {
    const { limiter, counters } = make();
    counters.down = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = limiter.aiGate('1.1.1.1');
    expect(await gate.allow()).toBe(false);
    expect(gate.skipped).toBe(true);
  });
});
