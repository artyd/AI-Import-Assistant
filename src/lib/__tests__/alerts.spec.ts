import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const cfg = vi.hoisted(() => ({ OPS_ADMIN_EMAILS: '', ALERT_THROTTLE_MINUTES: 15 }));
const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('../../db/pool.js', () => ({ query: queryMock }));

import {
  _resetAlertsForTests,
  classifyAnthropicError,
  formatMessage,
  notifyOpsAsync,
  pickRecipients,
  sanitizeDetail,
  scrubSecrets,
  throttleDecision,
} from '../alerts.js';
import { registerOpsAlertHooks } from '../alertHooks.js';

const users = [
  { id: 'u1', email: 'Boss@Example.com' },
  { id: 'u2', email: 'dev@example.com' },
];

function inserts(): unknown[][] {
  return queryMock.mock.calls
    .filter((c) => String(c[0]).includes('INSERT INTO notifications'))
    .map((c) => c[1] as unknown[]);
}

beforeEach(() => {
  _resetAlertsForTests();
  cfg.OPS_ADMIN_EMAILS = '';
  cfg.ALERT_THROTTLE_MINUTES = 15;
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM users')) return { rows: users };
    if (sql.includes('FROM workspaces')) return { rows: [{ owner_id: 'u2' }] };
    return { rows: [], rowCount: 1 };
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('recipients', () => {
  it('everyone when OPS_ADMIN_EMAILS is empty', () => {
    expect(pickRecipients(users, '')).toEqual(['u1', 'u2']);
  });
  it('only listed emails, case-insensitive', () => {
    expect(pickRecipients(users, ' boss@example.COM ')).toEqual(['u1']);
  });
  it('inserts one ops_alert per recipient', async () => {
    cfg.OPS_ADMIN_EMAILS = 'boss@example.com';
    const n = await notifyOpsAsync({ source: 'chat', severity: 'error', title: 'boom' });
    expect(n).toBe(1);
    const rows = inserts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]).toBe('u1');
    expect(rows[0]?.[2]).toBe('ops_alert');
    expect(String(rows[0]?.[3])).toContain('⚠ Збій: чат — boom');
  });
  it('links the shipment only for its owner', async () => {
    await notifyOpsAsync({ source: 'ingest', severity: 'error', title: 't', workspaceId: 'w1' });
    const byUser = Object.fromEntries(inserts().map((r) => [r[0] as string, r[1]]));
    expect(byUser).toEqual({ u1: null, u2: 'w1' });
  });
});

describe('throttle', () => {
  it('pure decision counts suppressed', () => {
    const s = new Map();
    expect(throttleDecision(s, 'k', 0, 1000)).toEqual({ send: true, suppressed: 0 });
    expect(throttleDecision(s, 'k', 10, 1000).send).toBe(false);
    expect(throttleDecision(s, 'k', 20, 1000).send).toBe(false);
    expect(throttleDecision(s, 'k', 1001, 1000)).toEqual({ send: true, suppressed: 2 });
  });
  it('same key is delivered once; the message carries +N', async () => {
    const a = { source: 'worker', severity: 'error' as const, title: 'x', key: 'k' };
    expect(await notifyOpsAsync(a)).toBe(2);
    expect(await notifyOpsAsync(a)).toBe(0);
    expect(await notifyOpsAsync(a)).toBe(0);
    expect(inserts()).toHaveLength(2);
    expect(formatMessage(a, 2, new Date())).toContain('(+2 схожих)');
  });
});

describe('privacy', () => {
  it('scrubs keys, bearer tokens, JWTs and emails', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghij';
    const out = scrubSecrets(`key sk-ant-api03-AbC_123 Bearer abc.def-ghi jwt ${jwt} mail a@b.com`);
    expect(out).not.toMatch(/sk-ant-api03|abc\.def|eyJhbGci|a@b\.com/);
  });
  it('truncates to 500 chars', () => {
    const out = sanitizeDetail('x'.repeat(2000));
    expect(out.length).toBe(500);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('failure modes', () => {
  it('never throws and logs a fallback line when the DB insert fails', async () => {
    queryMock.mockRejectedValue(new Error('db down'));
    await expect(notifyOpsAsync({ source: 'chat', severity: 'error', title: 'z' })).resolves.toBe(0);
    const lines = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"ops_alert":true') && l.includes('delivery_failed'))).toBe(true);
  });
});

describe('anthropic classification', () => {
  it('maps outage statuses', () => {
    expect(classifyAnthropicError({ status: 401 })?.key).toBe('anthropic-auth');
    expect(classifyAnthropicError({ status: 403 })?.key).toBe('anthropic-auth');
    expect(classifyAnthropicError({ status: 400, message: 'Your credit balance is too low' })?.key).toBe(
      'anthropic-billing',
    );
    expect(classifyAnthropicError({ status: 529 })?.key).toBe('anthropic-overloaded');
    expect(classifyAnthropicError({ status: 400 })).toBeNull();
  });
});

describe('5xx hook', () => {
  function app() {
    const a = Fastify();
    registerOpsAlertHooks(a);
    a.get('/boom', async () => {
      throw new Error('kaput');
    });
    a.get('/bad', async () => {
      throw Object.assign(new Error('bad'), { statusCode: 400 });
    });
    a.get('/denied', async () => {
      throw Object.assign(new Error('no'), { statusCode: 401 });
    });
    return a;
  }
  it('alerts on 500 and keeps the response', async () => {
    const res = await app().inject('/boom');
    expect(res.statusCode).toBe(500);
    await new Promise((r) => setTimeout(r, 20));
    expect(inserts().length).toBeGreaterThan(0);
    expect(String(inserts()[0]?.[3])).toContain('GET /boom → 500');
  });
  it('does not alert on 4xx', async () => {
    const a = app();
    expect((await a.inject('/bad')).statusCode).toBe(400);
    expect((await a.inject('/denied')).statusCode).toBe(401);
    expect((await a.inject('/unknown')).statusCode).toBe(404);
    await new Promise((r) => setTimeout(r, 20));
    expect(inserts()).toHaveLength(0);
  });
});
