import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

vi.mock('../../../lib/config.js', () => ({ config: { OCR_ENABLED: false, MARKDOWN_VISION_ENABLED: false } }));
vi.mock('../vision.js', () => ({}));

const { gridToMarkdown } = await import('../format.js');
const { convertToMarkdown } = await import('../convert.js');

describe('spreadsheet → Markdown', () => {
  it('a title block above the table stays text; the real header row heads the table; rows keep Excel numbers', () => {
    const md = gridToMarkdown(
      [
        ['COMMERCIAL INVOICE No. CI-77', '', '', ''],
        ['Seller: Foo Co., Ltd', '', 'Date: 2026-10-01', ''],
        ['', '', '', ''],
        ['Description', 'Qty, kg', 'Price', 'Amount'],
        ['L-Lysine HCl', '25 000', '1.20', '30 000.00'],
      ],
      3,
    );
    expect(md).toBe(
      [
        'COMMERCIAL INVOICE No. CI-77',
        'Seller: Foo Co., Ltd · Date: 2026-10-01',
        '',
        '| Рядок | Description | Qty, kg | Price | Amount |',
        '| --- | --- | --- | --- | --- |',
        '| 7 | L-Lysine HCl | 25 000 | 1.20 | 30 000.00 |',
      ].join('\n'),
    );
  });

  it('a one-column sheet is plain lines', () => {
    expect(gridToMarkdown([['a'], [''], ['b']])).toBe('a\nb');
  });

  it('merged header cells fill across, not down; hidden sheets are skipped', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Goods', '', 'Weight', ''],
      ['Name', 'Batch', 'Net', 'Gross'],
      ['Salt', 'B1', '10', '25'],
      ['Salt', 'B2', '10', ''],
    ]);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }, // «Goods» over two columns
      { s: { r: 0, c: 2 }, e: { r: 0, c: 3 } }, // «Weight» over two columns
      { s: { r: 2, c: 3 }, e: { r: 3, c: 3 } }, // gross 25 kg for both rows of the pallet
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'PL');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['secret', 'x']]), 'calc');
    wb.Workbook = { Sheets: [{ name: 'PL', Hidden: 0 }, { name: 'calc', Hidden: 1 }] };
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const { pages } = await convertToMarkdown(buf, 'xlsx', 'pl.xlsx');
    expect(pages).toHaveLength(1);
    const md = pages[0]!.markdown;
    expect(md).toContain('| Рядок | Goods | Goods | Weight | Weight |');
    expect(md).toContain('| 3 | Salt | B1 | 10 | 25 |');
    expect(md).toContain('| 4 | Salt | B2 | 10 |  |'); // 25 kg not repeated
  });
});
