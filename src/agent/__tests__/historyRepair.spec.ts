import { describe, expect, it } from 'vitest';
import type { ChatMessageParam } from '../../anthropic/client.js';
import { repairBlocks, stripToolBlocks } from '../historyRepair.js';

const toolUse = (id: string) => ({ type: 'tool_use' as const, id, name: 'read_file', input: {} });
const toolResult = (id: string) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'x' });
const text = (t: string) => ({ type: 'text' as const, text: t });

describe('repairBlocks', () => {
  it('keeps a valid tool round-trip untouched (minus thinking)', () => {
    const msgs: ChatMessageParam[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, text('look'), toolUse('a')],
      },
      { role: 'user', content: [toolResult('a')] },
      { role: 'assistant', content: [text('answer')] },
    ];
    expect(repairBlocks(msgs)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [text('look'), toolUse('a')] },
      { role: 'user', content: [toolResult('a')] },
      { role: 'assistant', content: [text('answer')] },
    ]);
  });

  it('drops a trailing tool_use cut off by max_tokens (no tool_result follows)', () => {
    const msgs: ChatMessageParam[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [text('partial'), toolUse('b')] },
    ];
    expect(repairBlocks(msgs)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [text('partial')] },
    ]);
  });

  it('drops thinking-only (empty) assistant messages and orphan tool_results', () => {
    const msgs: ChatMessageParam[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '…', signature: 's' }] },
      { role: 'user', content: [toolResult('ghost'), text('follow-up')] },
    ];
    expect(repairBlocks(msgs)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'user', content: [text('follow-up')] },
    ]);
  });

  it('never starts with an assistant or a tool_result-only message', () => {
    const msgs: ChatMessageParam[] = [
      { role: 'assistant', content: [text('old answer')] },
      { role: 'user', content: [toolResult('z')] },
      { role: 'user', content: 'new question' },
    ];
    expect(repairBlocks(msgs)).toEqual([{ role: 'user', content: 'new question' }]);
  });
});

describe('stripToolBlocks', () => {
  it('removes tool blocks and keeps prose for tool-less turns', () => {
    const msgs: ChatMessageParam[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [text('checking'), toolUse('a')] },
      { role: 'user', content: [toolResult('a')] },
      { role: 'assistant', content: [text('done')] },
    ];
    expect(stripToolBlocks(msgs)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [text('checking')] },
      { role: 'assistant', content: [text('done')] },
    ]);
  });
});

describe('stableWindowStart', () => {
  it('keeps everything under budget', async () => {
    const { stableWindowStart } = await import('../historyRepair.js');
    expect(stableWindowStart([10, 10, 10], 100)).toBe(0);
  });

  it('drops old groups in quantized jumps so the start is stable across turns', async () => {
    const { stableWindowStart } = await import('../historyRepair.js');
    const budget = 100; // step 40
    const sizes = Array.from({ length: 12 }, () => 10); // 120 total → drop ≥40
    const s1 = stableWindowStart(sizes, budget);
    expect(s1).toBe(4);
    // Next two turns add 10 each: total 130, 140 → still drop 40 → same start.
    expect(stableWindowStart([...sizes, 10], budget)).toBe(s1);
    expect(stableWindowStart([...sizes, 10, 10], budget)).toBe(s1);
    // Crossing the next step (total 150 → drop 80) jumps forward once.
    expect(stableWindowStart([...sizes, 10, 10, 10], budget)).toBe(8);
  });

  it('always keeps the newest group', async () => {
    const { stableWindowStart } = await import('../historyRepair.js');
    expect(stableWindowStart([500, 500], 100)).toBe(1);
  });
});
