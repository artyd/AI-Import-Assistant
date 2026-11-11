import { describe, expect, it, vi } from 'vitest';
import { instrumentQuery, sqlPreview, SQL_PREVIEW_CHARS } from '../slowQuery.js';

function fakeClock(...ticks: number[]) {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)]!;
}

describe('instrumentQuery', () => {
  it('reports a slow promise query with duration and SQL, never the params', async () => {
    const target = { query: vi.fn(async () => ({ rows: [1] })) };
    const onSlow = vi.fn();
    instrumentQuery(target, 500, onSlow, fakeClock(0, 750));
    const res = await target.query('SELECT * FROM users WHERE email = $1', ['secret@example.com']);
    expect(res).toEqual({ rows: [1] });
    expect(onSlow).toHaveBeenCalledOnce();
    expect(onSlow.mock.calls[0]![0]).toEqual({ ms: 750, sql: 'SELECT * FROM users WHERE email = $1' });
    expect(JSON.stringify(onSlow.mock.calls)).not.toContain('secret@example.com');
  });

  it('stays silent for fast queries', async () => {
    const target = { query: vi.fn(async () => ({ rows: [] })) };
    const onSlow = vi.fn();
    instrumentQuery(target, 500, onSlow, fakeClock(0, 20));
    await target.query('SELECT 1');
    expect(onSlow).not.toHaveBeenCalled();
  });

  it('still reports and rethrows when a slow query fails', async () => {
    const target = { query: vi.fn(async () => { throw new Error('boom'); }) };
    const onSlow = vi.fn();
    instrumentQuery(target, 100, onSlow, fakeClock(0, 300));
    await expect(target.query('UPDATE t SET a = 1')).rejects.toThrow('boom');
    expect(onSlow).toHaveBeenCalledOnce();
  });

  it('times callback-style queries and keeps the callback working', () => {
    const target = { query: (_sql: string, cb: (e: null, r: string) => void) => cb(null, 'ok') };
    const onSlow = vi.fn();
    instrumentQuery(target as never, 100, onSlow, fakeClock(0, 400));
    const cb = vi.fn();
    (target as { query: (s: string, c: unknown) => void }).query('SELECT 2', cb);
    expect(cb).toHaveBeenCalledWith(null, 'ok');
    expect(onSlow).toHaveBeenCalledOnce();
  });

  it('threshold 0 disables wrapping', () => {
    const q = vi.fn();
    const target = { query: q };
    instrumentQuery(target, 0, vi.fn());
    expect(target.query).toBe(q);
  });

  it('accepts query-config objects and truncates long SQL to 200 chars', () => {
    expect(sqlPreview({ text: 'SELECT\n  1', values: ['x'] })).toBe('SELECT 1');
    expect(sqlPreview('SELECT ' + 'a'.repeat(500))).toHaveLength(SQL_PREVIEW_CHARS);
  });
});
