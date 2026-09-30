import { describe, expect, it, vi } from 'vitest';
import {
  groupPagesByChars,
  htmlToMarkdown,
  joinPages,
  rowsToMarkdownTable,
  splitVisionPages,
} from '../format.js';
import { buildTsQuery, diversifyByDocument, substringPatterns, type SearchHit } from '../searchQuery.js';

describe('rowsToMarkdownTable', () => {
  it('renders a GFM table, escapes pipes and drops empty rows/trailing columns', () => {
    const md = rowsToMarkdownTable([
      ['Товар', 'К-сть', 'Сума', ''],
      [],
      ['Paracetamol | API', 100, 2500.5, ''],
    ]);
    expect(md).toBe(
      ['| Товар | К-сть | Сума |', '| --- | --- | --- |', '| Paracetamol \\| API | 100 | 2500.5 |'].join('\n'),
    );
  });

  it('returns empty string for an empty sheet', () => {
    expect(rowsToMarkdownTable([[], ['', null]])).toBe('');
  });
});

describe('htmlToMarkdown', () => {
  it('converts mammoth headings, paragraphs, lists, emphasis and tables', () => {
    const html =
      '<h1>Контракт № 12/24</h1><p>Продавець: <strong>ABC Ltd</strong> &amp; Co</p>' +
      '<ul><li>пункт 1</li><li>пункт 2</li></ul>' +
      '<table><tr><td><p>Товар</p></td><td><p>Ціна</p></td></tr>' +
      '<tr><td><p>Ibuprofen</p><p>USP</p></td><td><p>10</p></td></tr></table>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('# Контракт № 12/24');
    expect(md).toContain('Продавець: **ABC Ltd** & Co');
    expect(md).toContain('- пункт 1\n');
    expect(md).toContain('| Товар | Ціна |\n| --- | --- |\n| Ibuprofen / USP | 10 |');
  });
});

describe('splitVisionPages', () => {
  it('splits on page markers and keeps real page numbers', () => {
    const pages = splitVisionPages('<!-- стор. 6 -->\n# Invoice\n<!-- стор. 7 -->\n| a | b |', 6, 10);
    expect(pages).toEqual([
      { page: 6, markdown: '# Invoice' },
      { page: 7, markdown: '| a | b |' },
    ]);
  });

  it('attributes marker-less output to the first page instead of dropping it', () => {
    expect(splitVisionPages('just text', 11, 15)).toEqual([{ page: 11, markdown: 'just text' }]);
  });

  it('ignores out-of-range markers and merges preamble into the first page', () => {
    const pages = splitVisionPages('Header\n<!-- стор. 1 -->\nA\n<!-- стор. 99 -->\nB', 1, 5);
    expect(pages).toEqual([{ page: 1, markdown: 'Header\n\nA\n<!-- стор. 99 -->\nB' }]);
  });
});

describe('groupPagesByChars / joinPages', () => {
  it('groups by page boundary and hard-splits an oversized page', () => {
    const parts = groupPagesByChars(
      [
        { page: 1, markdown: 'a'.repeat(6) },
        { page: 2, markdown: 'b'.repeat(6) },
        { page: 3, markdown: 'c'.repeat(25) },
      ],
      10,
    );
    expect(parts.map((p) => p.map((x) => `${x.page}:${x.markdown.length}`))).toEqual([
      ['1:6'],
      ['2:6'],
      ['3:10'],
      ['3:10'],
      ['3:5'],
    ]);
  });

  it('joins pages with page headers', () => {
    expect(joinPages([{ page: 2, markdown: 'x' }, { page: null, markdown: 'y' }])).toBe('--- стор. 2 ---\nx\n\ny');
  });
});

describe('full-text search helpers', () => {
  it('builds prefix tsquery tolerant to Ukrainian inflection', () => {
    expect(buildTsQuery('ваги інвойсу 2941')).toBe('ваг:* | інвой:* | 2941:*');
    expect(buildTsQuery('в і 01')).toBeNull();
  });

  it('adds substring patterns for codes and short phrases', () => {
    expect(substringPatterns('UA/19603/01/01')).toEqual(['%UA/19603/01/01%']);
    expect(substringPatterns('net weight')).toEqual(['%net weight%']);
    expect(substringPatterns('50%_off1')).toEqual(['%50\\%\\_off1%']);
  });

  it('diversifies hits across documents', () => {
    const h = (fileId: string, score: number): SearchHit => ({
      file: fileId,
      fileId,
      page: null,
      folder: null,
      text: '',
      score,
    });
    const out = diversifyByDocument([h('a', 9), h('a', 8), h('a', 7), h('b', 1)], 2, 6);
    expect(out.map((x) => x.fileId)).toEqual(['a', 'b']);
  });
});

describe('splitLongMarkdown', () => {
  it('splits on row boundaries and repeats the table header', async () => {
    const { splitLongMarkdown } = await import('../format.js');
    const rows = Array.from({ length: 6 }, (_, i) => `| item${i} | ${i}0 |`);
    const md = ['| Товар | К-сть |', '| --- | --- |', ...rows].join('\n');
    const parts = splitLongMarkdown(md, 60);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.startsWith('| Товар | К-сть |\n| --- | --- |')).toBe(true);
      for (const line of p.split('\n')) expect(line.endsWith('|')).toBe(true);
    }
    const allRows = parts.flatMap((p) => p.split('\n').filter((l) => l.startsWith('| item')));
    expect(allRows).toEqual(rows);
  });
});

describe('stripControlChars', () => {
  it('drops NUL and C0 controls but keeps tabs/newlines', async () => {
    vi.doMock('../../../config.js', () => ({ config: {} }));
    vi.doMock('../vision.js', () => ({}));
    const { stripControlChars } = await import('../convert.js');
    expect(stripControlChars('a\u0000b\u0007c\td\ne\r')).toBe('abc\td\ne\r');
  });
});
