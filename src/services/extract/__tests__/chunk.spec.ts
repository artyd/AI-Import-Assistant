import { describe, it, expect } from 'vitest';
import { chunkPages } from '../chunk.js';

describe('chunkPages', () => {
  it('carries the page header into continuation chunks (split wide table)', () => {
    const header = 'Опис | К-сть | Ціна | Сума';
    const body = Array.from({ length: 400 }, (_, i) => `Товар ${i} | 10 | 5.00 | 50.00`).join('\n');
    const chunks = chunkPages([{ page: 1, text: `${header}\n${body}` }]);
    expect(chunks.length).toBeGreaterThan(1);
    // Every continuation chunk keeps the column header so rows stay labelled.
    for (const c of chunks.slice(1)) {
      expect(c.text.startsWith(header)).toBe(true);
    }
    // Chunks never cross the page boundary — citations stay precise.
    expect(chunks.every((c) => c.page === 1)).toBe(true);
  });

  it('short page → single chunk, no header duplication', () => {
    const chunks = chunkPages([{ page: 1, text: 'Short invoice text.' }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('Short invoice text.');
  });
});
