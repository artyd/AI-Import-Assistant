import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { appendFclSheets, fclSheetRows } from '../export/fclSheets.js';
import type { FclVerdicts } from '../../shipments/fclState.js';

const v = {
  files: [],
  lots: [
    {
      lot: { id: 'L1', name: 'Shandong', supplier_name: 'Shandong Betaine' },
      consignee: 'НОВАЛАЙТ',
      fileCount: 4,
      intakeComplete: true,
      verdicts: {
        checklist: [
          { requirement_key: 'invoice', status: 'verified', source_file_id: 'a' },
          { requirement_key: 'packing_list', status: 'missing', source_file_id: null },
        ],
        discrepancies: [
          { field: 'net_weight_kg', expected: '5000', actual: '4900', severity: 'error', kind: 'confirmed', citations: [] },
        ],
        risks: [{ code: 'x', category: 'expiry', severity: 'error', title: 'CoA прострочений', detail: '', source_file_id: null }],
        derivedStatus: 'docs_in_progress',
      },
    },
  ],
  level: {
    checklist: [],
    discrepancies: [],
    risks: [],
    consignees: [],
    hblLot: {},
    containers: [],
    euTransit: null,
    unassigned: 0,
    levelStatus: 'docs_in_progress',
    derivedStatus: 'docs_in_progress',
    manifest: {
      file_id: 'm',
      file_name: 'm.xlsx',
      built: false,
      discrepancies: [],
      matches: [
        {
          manifest: { name: 'Betaine', qtyKg: 5000, unitPrice: 2.1, code: null },
          invoice: { lot_id: 'L1', lot_name: 'Shandong', file_id: 'i', file_name: 'INV.pdf', description: 'Betaine anhydrous', qty_kg: 5000, unit_price: 2.1, hs_code: null },
          status: 'ok',
        },
      ],
    },
  },
} as unknown as FclVerdicts;

describe('FCL reconciliation sheets', () => {
  it('rows for lots, manifest, discrepancies (labelled by lot) and risks', () => {
    const rows = fclSheetRows(v);
    expect(rows['Партії']![1]).toEqual(['Shandong', 'Shandong Betaine', 'НОВАЛАЙТ', 'docs_in_progress', '1/2', 1, 0, 1, 4]);
    expect(rows['Звірка маніфесту']![1]![8]).toBe('збігається');
    expect(rows['Розбіжності']![1]![0]).toBe('Shandong');
    expect(rows['Ризики по партіях']![1]![0]).toBe('Shandong: CoA прострочений');
  });

  it('appends the sheets to an existing workbook', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Зведена');
    const out = appendFclSheets(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer, v);
    expect(XLSX.read(out, { type: 'buffer' }).SheetNames).toEqual(['Зведена', 'Партії', 'Звірка маніфесту', 'Розбіжності', 'Ризики по партіях']);
  });
});
