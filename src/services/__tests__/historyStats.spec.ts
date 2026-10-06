import { describe, expect, it, vi } from 'vitest';

const rows: { role: 'user' | 'assistant'; content: string; blocks: null }[] = [];
vi.mock('../../db/pool.js', () => ({ query: vi.fn(async () => ({ rows })) }));
vi.mock('../../config.js', () => ({ config: { AGENT_HISTORY_CHAR_BUDGET: 1000 } }));

describe('getConversationHistoryWithStats (chat-window meter)', () => {
  it('counts user turns kept in the window vs the whole chat', async () => {
    const { getConversationHistoryWithStats } = await import('../conversations.js');
    rows.length = 0;
    for (let i = 0; i < 6; i++) {
      rows.push({ role: 'user', content: `питання ${i} ${'x'.repeat(150)}`, blocks: null });
      rows.push({ role: 'assistant', content: `відповідь ${i} ${'y'.repeat(150)}`, blocks: null });
    }
    const { history, stats } = await getConversationHistoryWithStats('c1');
    expect(stats.totalTurns).toBe(6);
    expect(stats.keptTurns).toBeGreaterThan(0);
    expect(stats.keptTurns).toBeLessThan(6); // ~2k chars of chat vs a 1k budget
    expect(stats.historyChars).toBeLessThanOrEqual(stats.historyBudgetChars);
    expect(stats.historyBudgetChars).toBe(1000);
    expect(history[0]?.role).toBe('user');
  });

  it('reports a fresh chat as empty', async () => {
    const { getConversationHistoryWithStats } = await import('../conversations.js');
    rows.length = 0;
    const { history, stats } = await getConversationHistoryWithStats('c2');
    expect(history).toEqual([]);
    expect(stats).toMatchObject({ totalTurns: 0, keptTurns: 0, historyChars: 0 });
  });
});
