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
