import { describe, expect, it } from 'vitest';
import {
  assertCaseLimit,
  compareRuns,
  formatCompare,
  median,
  score,
  summarizeRun,
  unsupportedFigures,
  wordCount,
} from '../eval-answers-lib.mjs';

describe('wordCount', () => {
  it('counts words, ignoring markdown markers and table pipes', () => {
    expect(wordCount('**Брутто 4 040 кг** — INVOICE.pdf, стор. 2')).toBe(7);
    expect(wordCount('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(4);
    expect(wordCount('')).toBe(0);
  });
});

describe('median', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('unsupportedFigures', () => {
  it('accepts a figure with a file name in the same sentence', () => {
    const r = unsupportedFigures('**Брутто 4 040 кг** (Booking order.pdf, стор. 1).');
    expect(r.total).toBe(1);
    expect(r.unsupported).toEqual([]);
  });
  it('flags a figure without a source', () => {
    const r = unsupportedFigures('**Брутто 4 040 кг.** Вага у файлі Packing.pdf інша.');
    expect(r.unsupported.map((u) => u.figure)).toEqual(['4 040']);
  });
  it('a table row needs its own source', () => {
    const t = '| Показник | Значення | Файл |\n|---|---|---|\n| Брутто | 4 040 кг | A.pdf |\n| Нетто | 3 900 кг | |';
    const r = unsupportedFigures(t);
    expect(r.total).toBe(2);
    expect(r.unsupported.map((u) => u.figure)).toEqual(['3 900']);
  });
  it('ignores dates, years, list numbers and one-digit counts', () => {
    const r = unsupportedFigures('1. Дата 06.10.2026 у 2026 році, 2 файли.');
    expect(r.total).toBe(0);
  });
  it('counts decimals as one figure', () => {
    const r = unsupportedFigures('Ціна 8,041 EUR/кг.');
    expect(r.unsupported.map((u) => u.figure)).toEqual(['8,041']);
  });
});

describe('score', () => {
  const c = {
    expect: [{ name: 'брутто', any: [String.raw`4\s?040`] }],
    forbid: [String.raw`4\s?080`],
    maxWords: 10,
  };
  it('scores correctness, forbid, words and verdict-first', () => {
    const s = score(c, '**Брутто 4 040 кг** (A.pdf).');
    expect(s.correctness).toBe(1);
    expect(s.forbidden).toEqual([]);
    expect(s.words).toBe(5);
    expect(s.verdictFirst).toBe(true);
    expect(s.score).toBeGreaterThan(0.8);
  });
  it('catches forbidden figure, preamble and over-length', () => {
    const s = score(c, 'Звісно, дивлюся. Брутто 4 080 кг, а далі довгий текст що перевищує ліміт слів точно так.');
    expect(s.correctness).toBe(0);
    expect(s.forbidden).toEqual([String.raw`4\s?080`]);
    expect(s.verdictFirst).toBe(false);
    expect(s.shape.find((x) => x.name.startsWith('довжина')).ok).toBe(false);
  });
  it('stays backward compatible without the new fields', () => {
    const s = score({ expect: [{ name: 'x', any: ['x'] }] }, '**x**\nДія: так');
    expect(s.shape).toHaveLength(4);
    expect(s.score).toBe(1);
  });
});

describe('summarizeRun / compareRuns', () => {
  const mk = (name, correctness, words, unsupported, seconds) => ({ name, correctness, words, unsupported, seconds });
  const oldRun = { cases: [mk('a', 1, 100, 3, 20), mk('b', 0.5, 200, 5, 30)] };
  const newRun = { cases: [mk('a', 1, 40, 0, 10), mk('b', 1, 60, 1, 12)] };

  it('summarizes', () => {
    expect(summarizeRun(newRun)).toEqual({ cases: 2, correctness: 1, medianWords: 50, unsupported: 1, seconds: 22 });
  });
  it('compares per case and in total, no drop', () => {
    const cmp = compareRuns(oldRun, newRun);
    expect(cmp.rows.map((r) => r.name)).toEqual(['a', 'b']);
    expect(cmp.totals.old.correctness).toBe(0.75);
    expect(cmp.totals.new.correctness).toBe(1);
    expect(cmp.dropped).toBe(false);
    expect(formatCompare(cmp)).toContain('b');
  });
  it('flags a drop in total correctness', () => {
    expect(compareRuns(newRun, oldRun).dropped).toBe(true);
  });
  it('lists cases present in only one run', () => {
    const cmp = compareRuns(oldRun, { cases: [mk('a', 1, 40, 0, 10), mk('c', 1, 10, 0, 5)] });
    expect(cmp.rows.map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('assertCaseLimit', () => {
  it('refuses more than 15 cases unless forced', () => {
    expect(() => assertCaseLimit(16, false)).toThrow(/15/);
    expect(() => assertCaseLimit(15, false)).not.toThrow();
    expect(() => assertCaseLimit(40, true)).not.toThrow();
  });
});
