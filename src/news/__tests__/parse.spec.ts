import { describe, it, expect } from 'vitest';
import { stripHtml, buildSummary, hashItem, toDate, mapItems, SUMMARY_MAX } from '../parse.js';
import type { FeedItem } from '../parse.js';
import type { NewsSource } from '../sources.js';

const SRC: NewsSource = { rubric: 'freight', name: 'The Loadstar', url: 'https://example.test/feed' };

describe('stripHtml', () => {
  it('removes tags, decodes entities, collapses whitespace', () => {
    expect(stripHtml('<p>Rates&nbsp;up   &amp; down</p>')).toBe('Rates up & down');
  });
});

describe('buildSummary', () => {
  it('prefers contentSnippet and caps at SUMMARY_MAX with an ellipsis', () => {
    const long = 'a'.repeat(SUMMARY_MAX + 50);
    const out = buildSummary({ contentSnippet: long });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(SUMMARY_MAX);
    expect(out!.endsWith('…')).toBe(true);
  });
  it('falls back to summary→content and strips HTML', () => {
    expect(buildSummary({ content: '<b>Hi</b> there' })).toBe('Hi there');
  });
  it('returns null when there is no text', () => {
    expect(buildSummary({})).toBeNull();
  });
});

describe('hashItem', () => {
  it('is a stable sha256 of url|title', () => {
    const a = hashItem('https://x/1', 'Title');
    const b = hashItem('https://x/1', 'Title');
    const c = hashItem('https://x/2', 'Title');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('toDate', () => {
  it('parses isoDate then pubDate', () => {
    expect(toDate({ isoDate: '2026-09-01T00:00:00.000Z' }).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });
  it('falls back to now() on a missing/unparseable date', () => {
    const before = Date.now();
    const d = toDate({ pubDate: 'not-a-date' });
    expect(d.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('mapItems', () => {
  it('maps parsed items to rows, carrying rubric+source and computing the hash', () => {
    const items: FeedItem[] = [
      {
        title: 'Ocean freight spikes',
        link: 'https://example.test/a',
        contentSnippet: 'Spot rates jumped',
        isoDate: '2026-09-10T12:00:00.000Z',
      },
    ];
    const rows = mapItems(SRC, items);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.rubric).toBe('freight');
    expect(row.source).toBe('The Loadstar');
    expect(row.url).toBe('https://example.test/a');
    expect(row.summary).toBe('Spot rates jumped');
    expect(row.hash).toBe(hashItem('https://example.test/a', 'Ocean freight spikes'));
  });

  it('drops items with neither url nor title', () => {
    const rows = mapItems(SRC, [{ contentSnippet: 'orphan' }]);
    expect(rows).toHaveLength(0);
  });
});
