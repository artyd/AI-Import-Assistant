import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../../db/pool.js', () => ({ query, pool: {} }));
vi.mock('../../lib/config.js', () => ({ config: { AGENT_HISTORY_CHAR_BUDGET: 1_000_000 } }));

const { rewindConversation } = await import('../conversations.js');

describe('rewindConversation — «Редагувати й надіслати знову»', () => {
  beforeEach(() => query.mockReset());

  it('deletes the user message and everything after it, scoped to the conversation', async () => {
    query.mockResolvedValueOnce({ rows: [{ created_at: '2026-11-13T10:00:00Z' }] }).mockResolvedValueOnce({ rows: [] });
    expect(await rewindConversation('conv-1', 'msg-7')).toBe(true);
    expect(query.mock.calls[0]![1]).toEqual(['msg-7', 'conv-1']);
    expect(String(query.mock.calls[0]![0])).toContain("role = 'user'");
    expect(String(query.mock.calls[1]![0])).toContain('DELETE FROM messages WHERE conversation_id = $1 AND created_at >= $2');
    expect(query.mock.calls[1]![1]).toEqual(['conv-1', '2026-11-13T10:00:00Z']);
  });

  it('a message of another conversation (or an assistant message) deletes nothing', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await rewindConversation('conv-1', 'foreign')).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
