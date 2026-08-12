import { query } from '../db/pool.js';
import type { ExtractedFields } from './extraction/extractFields.js';

/**
 * Deterministic cross-document reconciliation. Reads the latest structured
 * extractions for the invoice / purchase-order / packing-list of a workspace and
 * compares agreed fields. It NEVER re-reads raw document text — findings are a
 * pure function of `document_extractions`.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Discrepancy {
  field: string;
  expected: string;
  actual: string;
  severity: Severity;
}

// Weight may legitimately differ slightly between invoice and packing list
// (rounding, net vs gross). Flag only when it exceeds this relative tolerance.
const WEIGHT_TOLERANCE = 0.01; // 1%

type Fields = Partial<ExtractedFields> & Record<string, unknown>;

function pick(rows: { doc_type: string | null; fields: Fields }[], type: string): Fields | null {
  return rows.find((r) => r.doc_type === type)?.fields ?? null;
}

function show(v: unknown): string {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

export async function computeDiscrepancies(workspaceId: string): Promise<Discrepancy[]> {
  const { rows } = await query<{ doc_type: string | null; fields: Fields }>(
    `SELECT de.extracted_fields->>'doc_type' AS doc_type,
            de.extracted_fields AS fields
     FROM document_extractions de
     JOIN files f ON f.id = de.file_id
     WHERE de.workspace_id = $1 AND f.is_latest = true`,
    [workspaceId],
  );

  const invoice = pick(rows, 'invoice');
  const po = pick(rows, 'purchase_order');
  const packing = pick(rows, 'packing_list');

  const out: Discrepancy[] = [];

  // PO number should agree across invoice / PO / packing list.
  const poNumbers = [
    ['invoice', invoice?.po_number],
    ['purchase_order', po?.po_number],
    ['packing_list', packing?.po_number],
  ].filter(([, v]) => v) as [string, string][];
  if (poNumbers.length >= 2) {
    const distinct = new Set(poNumbers.map(([, v]) => v.trim().toLowerCase()));
    if (distinct.size > 1) {
      out.push({
        field: 'po_number',
        expected: show(poNumbers[0]![1]),
        actual: poNumbers.map(([d, v]) => `${d}: ${v}`).join(' | '),
        severity: 'error',
      });
    }
  }

  // Total weight: invoice vs packing list, within tolerance.
  const wInv = invoice?.total_weight_kg as number | null | undefined;
  const wPl = packing?.total_weight_kg as number | null | undefined;
  if (typeof wInv === 'number' && typeof wPl === 'number' && wInv > 0) {
    const rel = Math.abs(wInv - wPl) / wInv;
    if (rel > WEIGHT_TOLERANCE) {
      out.push({
        field: 'total_weight_kg',
        expected: `invoice: ${wInv}`,
        actual: `packing_list: ${wPl}`,
        severity: 'warning',
      });
    }
  }

  // Packages count: invoice vs packing list, exact.
  const pInv = invoice?.packages_count as number | null | undefined;
  const pPl = packing?.packages_count as number | null | undefined;
  if (typeof pInv === 'number' && typeof pPl === 'number' && pInv !== pPl) {
    out.push({
      field: 'packages_count',
      expected: `invoice: ${pInv}`,
      actual: `packing_list: ${pPl}`,
      severity: 'error',
    });
  }

  // Value: invoice vs PO, exact (same currency).
  const vInv = invoice?.total_value as number | null | undefined;
  const vPo = po?.total_value as number | null | undefined;
  if (typeof vInv === 'number' && typeof vPo === 'number') {
    const sameCurrency = !invoice?.currency || !po?.currency || invoice.currency === po.currency;
    if (sameCurrency && vInv !== vPo) {
      out.push({
        field: 'total_value',
        expected: `purchase_order: ${vPo} ${show(po?.currency)}`,
        actual: `invoice: ${vInv} ${show(invoice?.currency)}`,
        severity: 'error',
      });
    }
  }

  // HS code presence on the invoice.
  if (invoice && !invoice.hs_code) {
    out.push({ field: 'hs_code', expected: 'наявний', actual: 'відсутній в інвойсі', severity: 'warning' });
  }

  // Country of origin presence (invoice or certificate of origin).
  const coo = invoice?.country_of_origin ?? pick(rows, 'certificate_of_origin')?.country_of_origin;
  if (invoice && !coo) {
    out.push({
      field: 'country_of_origin',
      expected: 'наявна',
      actual: 'відсутня',
      severity: 'warning',
    });
  }

  return out;
}
