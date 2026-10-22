import { describe, expect, it } from 'vitest';
import { buildManifestCsv, invoiceLines, reconcileManifest } from '../manifest.js';
import { mapColumns, parseCSV } from '../../analysis/sheets/parse.js';

const lotNames = { L1: 'Shandong', L2: 'Hebei' };
const files = [
  {
    file_id: 'i1',
    file_name: 'INV-1.pdf',
    lot_id: 'L1',
    fields: {
      doc_type: 'invoice',
      seller: 'Shandong Betaine Co Ltd',
      line_items: [{ description: 'Betaine anhydrous 98%', quantity: 5000, unit: 'kg', unit_price: 2.1 }],
    },
  },
  {
    // Our own resale invoice of the same goods — not a second line of the lot.
    file_id: 'pf',
    file_name: 'PF-INV.pdf',
    lot_id: 'L1',
    fields: {
      doc_type: 'invoice',
      seller: 'Prime Force UK',
      line_items: [{ description: 'Betaine anhydrous 98%', quantity: 5000, unit: 'kg', unit_price: 2.5 }],
    },
  },
  {
    file_id: 'i2',
    file_name: 'INV-2.pdf',
    lot_id: 'L2',
    fields: { doc_type: 'invoice', seller: 'Hebei Pharm', product_name: 'Caffeine anhydrous', net_weight_kg: 1000, total_value: 9000 },
  },
  { file_id: 'c', file_name: 'coa.pdf', lot_id: 'L2', fields: { doc_type: 'quality_certificate', product_name: 'Caffeine' } },
];

const manifestOf = (lines: { name: string; qtyKg: number; unitPrice: number }[]) => ({
  file_id: 'm',
  file_name: 'Маніфест.xlsx',
  built: false,
  lines: lines.map((l) => ({ ...l, code: null })),
});

describe('invoiceLines', () => {
  it('takes the supplier invoice lines, and the product + weight when there is no table', () => {
    const lines = invoiceLines(files, lotNames);
    expect(lines.map((l) => [l.file_id, l.description, l.qty_kg, l.unit_price])).toEqual([
      ['i1', 'Betaine anhydrous 98%', 5000, 2.1],
      ['i2', 'Caffeine anhydrous', 1000, 9],
    ]);
  });
});

describe('reconcileManifest', () => {
  const lines = invoiceLines(files, lotNames);

  it('every manifest line matched → no findings', () => {
    const r = reconcileManifest(manifestOf([{ name: 'BETAINE ANHYDROUS', qtyKg: 5000, unitPrice: 2.1 }, { name: 'Caffeine', qtyKg: 1000, unitPrice: 9 }]), lines);
    expect(r.discrepancies).toEqual([]);
    expect(r.matches.map((m) => m.status)).toEqual(['ok', 'ok']);
  });

  it('a kilogram mismatch is confirmed with both citations', () => {
    const r = reconcileManifest(manifestOf([{ name: 'Betaine', qtyKg: 4800, unitPrice: 2.1 }, { name: 'Caffeine', qtyKg: 1000, unitPrice: 9 }]), lines);
    const d = r.discrepancies.find((x) => x.field === 'manifest_qty');
    expect(d?.kind).toBe('confirmed');
    expect(d?.citations.map((c) => c.file_id)).toEqual(['m', 'i1']);
  });

  it('a manifest line without an invoice and an invoiced good off the manifest are suspected', () => {
    const r = reconcileManifest(manifestOf([{ name: 'Betaine', qtyKg: 5000, unitPrice: 2.1 }, { name: 'Glycine', qtyKg: 300, unitPrice: 3 }]), lines);
    expect(r.discrepancies.map((d) => `${d.field}:${d.kind}`).sort()).toEqual(['manifest_extra:suspected', 'manifest_line:suspected']);
  });
});

describe('buildManifestCsv', () => {
  it('builds a table the analysis parser reads', () => {
    const csv = buildManifestCsv(invoiceLines(files, lotNames));
    const rows = parseCSV(csv);
    const cols = mapColumns(rows[0]!);
    expect(cols.name).toBe(0);
    expect(cols.qty).toBe(1);
    expect(cols.price).toBe(2);
    expect(cols.code).toBe(3);
    expect(rows[1]![0]).toBe('Betaine anhydrous 98%');
  });
});
