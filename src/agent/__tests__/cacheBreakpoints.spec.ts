import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/config.js', () => ({ config: { LOGIST_MCP_URL: '' } }));

import { buildConsolidatedSystemPrompt, buildSystemPrompt } from '../systemPrompt.js';

const marks = (blocks: unknown): number =>
  Array.isArray(blocks) ? blocks.filter((b) => (b as { cache_control?: unknown }).cache_control).length : 0;

// The API allows 4 cache_control blocks per request: tools 1 + system 1 + the
// messages 2. A 5th (two marks in the FCL prompt) failed every follow-up turn.
describe('system prompt cache breakpoints', () => {
  it('each prompt uses at most one', () => {
    expect(marks(buildConsolidatedSystemPrompt({ number: '18', lots: [] }))).toBeLessThanOrEqual(1);
    expect(marks(buildSystemPrompt({ number: '1', supplier: null, contract_type: null, survey_status: null, parties: [], documentsDigest: '' } as never))).toBeLessThanOrEqual(1);
  });
});
