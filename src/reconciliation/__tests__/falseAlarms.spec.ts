import { describe, it, expect } from 'vitest';
import { reconcile, type ReconcileDoc } from '../reconcile.js';
import { assessRisks } from '../risks.js';

/** Spec 010 part E — false alarms of the deterministic checks. */
function doc(name: string, doc_type: string, fields: Record<string, unknown>): ReconcileDoc {
  return { file_id: name, file_name: name, doc_type, fields };
}
const row = (description: string | null, quantity: number, extra: Record<string, unknown> = {}) => ({
  description, quantity, unit: 'kg', unit_price: null, amount: null, hs_code: null, batch_no: null, ...extra,
});

describe('false alarms', () => {
  it('rows of a packing list without description/batch (cartons) are not a line-count mismatch', () => {
    const inv = doc('inv.pdf', 'invoice', { line_items: [row('Lysine', 25)], hs_code: '2309', country_of_origin: 'CN' });
    const pl = doc('pl.pdf', 'packing_list', { line_items: [row(null, 10), row(null, 10), row(null, 5)] });
    const out = reconcile([inv, pl]);
    expect(out.some((d) => d.field === 'line_items' && d.severity === 'error')).toBe(false);
  });

  it('two partial invoices with their own packing lists: weight sums differ per document, no RED', () => {
    const i1 = doc('inv1.pdf', 'invoice', { net_weight_kg: 10, gross_weight_kg: 11, packages_count: 1 });
    const i2 = doc('inv2.pdf', 'invoice', { net_weight_kg: 20, gross_weight_kg: 22, packages_count: 2 });
    const p1 = doc('pl1.pdf', 'packing_list', { net_weight_kg: 10, gross_weight_kg: 11, packages_count: 1 });
    const p2 = doc('pl2.pdf', 'packing_list', { net_weight_kg: 20, gross_weight_kg: 22, packages_count: 2 });
    const out = reconcile([i1, i2, p1, p2]);
    expect(out.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('rounding of gross weight on a transport document (31.85 → 32) is info, not a warning', () => {
    const inv = doc('inv.pdf', 'invoice', { gross_weight_kg: 31.85 });
    const awb = doc('awb.pdf', 'transport', { gross_weight_kg: 32 });
    const g = reconcile([inv, awb]).find((d) => d.field === 'gross_weight_kg');
    expect(g?.severity).toBe('info');
  });

  it('a real 5 % weight gap is still RED', () => {
    const inv = doc('inv.pdf', 'invoice', { gross_weight_kg: 30 });
    const awb = doc('awb.pdf', 'transport', { gross_weight_kg: 32 });
    expect(reconcile([inv, awb]).find((d) => d.field === 'gross_weight_kg')?.severity).toBe('error');
  });

  it('every finding carries its evidence (files + values), including duplicate-document notes', () => {
    const a = doc('a.pdf', 'invoice', { hs_code: '1' });
    const b = doc('b.pdf', 'invoice', { hs_code: '1' });
    const dup = reconcile([a, b]).find((d) => d.field === 'documents' && d.actual.includes('знайдено'));
    expect(dup?.citations.map((c) => c.file_name).sort()).toEqual(['a.pdf', 'b.pdf']);
  });

  it('a discrepancy risk names its source files', () => {
    const inv = doc('inv.pdf', 'invoice', { gross_weight_kg: 30 });
    const awb = doc('awb.pdf', 'transport', { gross_weight_kg: 32 });
    const d = reconcile([inv, awb]);
    const r = assessRisks({ extractions: [], missing: [], discrepancies: d, registry: [], now: 0 });
    const g = r.find((x) => x.code === 'discrepancy_gross_weight_kg');
    expect(g?.detail).toContain('inv.pdf');
    expect(g?.detail).toContain('awb.pdf');
    expect(g?.source_file_id).toBe('inv.pdf');
  });
});
