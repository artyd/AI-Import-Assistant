import { isInternalCompany, sameGoods } from '../shipments/lotAssign.js';
import type { Discrepancy } from './reconcile.js';

/**
 * Manifest ↔ documents (Збірник, spec 006 #05) — pure. The manifest is the
 * reference list of the container's goods; every line must find its invoice line
 * in some lot, with the same kilograms and unit price, and every invoiced good
 * must be on the manifest. When there is no manifest, one is built from the
 * invoices (`buildManifestCsv`) so the consolidated analysis still runs.
 */

export interface ManifestLine {
  name: string;
  qtyKg: number;
  unitPrice: number;
  code: string | null;
}

export interface InvoiceLine {
  lot_id: string;
  lot_name: string;
  file_id: string;
  file_name: string;
  description: string;
  /** Kilograms; null when the unit is not a weight. */
  qty_kg: number | null;
  unit_price: number | null;
  hs_code: string | null;
}

export type ManifestMatchStatus = 'ok' | 'qty' | 'price' | 'no_invoice' | 'not_in_manifest';

export interface ManifestMatch {
  manifest: ManifestLine | null;
  invoice: InvoiceLine | null;
  status: ManifestMatchStatus;
}

export interface ManifestReconciliation {
  file_id: string | null;
  file_name: string;
  /** true when the manifest was built from the invoices (no manifest file). */
  built: boolean;
  matches: ManifestMatch[];
  discrepancies: Discrepancy[];
}

interface InvoiceFile {
  file_id: string;
  file_name: string;
  lot_id: string | null;
  fields: Record<string, unknown> | null;
}

const QTY_TOLERANCE = 0.01;
const PRICE_TOLERANCE = 0.005;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function isKg(unit: string | null): boolean {
  return !unit || /^(kg|kgs|кг|kilo)/i.test(unit.trim());
}

/**
 * Goods lines of the lots' invoices. In a resale chain the same goods appear on
 * the supplier's invoice and on our own resale invoice; the supplier's one is the
 * line of the lot (ours only when the lot has nothing else).
 */
export function invoiceLines(files: InvoiceFile[], lotNames: Record<string, string>): InvoiceLine[] {
  const out: InvoiceLine[] = [];
  const byLot = new Map<string, InvoiceFile[]>();
  for (const f of files) {
    if (!f.lot_id || str(f.fields?.doc_type) !== 'invoice') continue;
    byLot.set(f.lot_id, [...(byLot.get(f.lot_id) ?? []), f]);
  }
  for (const [lotId, invoices] of byLot) {
    const supplierInvoices = invoices.filter((f) => !isInternalCompany(str(f.fields?.seller)));
    const chosen = supplierInvoices.length > 0 ? supplierInvoices : invoices;
    for (const f of chosen) {
      const items = Array.isArray(f.fields?.line_items) ? (f.fields!.line_items as Record<string, unknown>[]) : [];
      const base = { lot_id: lotId, lot_name: lotNames[lotId] ?? lotId, file_id: f.file_id, file_name: f.file_name };
      if (items.length > 0) {
        for (const li of items) {
          const description = str(li.description);
          if (!description) continue;
          const unit = str(li.unit);
          out.push({
            ...base,
            description,
            qty_kg: isKg(unit) ? num(li.quantity) : null,
            unit_price: isKg(unit) ? num(li.unit_price) : null,
            hs_code: str(li.hs_code),
          });
        }
      } else {
        const product = str(f.fields?.product_name);
        if (!product) continue;
        const kg = num(f.fields?.net_weight_kg) ?? num(f.fields?.total_weight_kg);
        const total = num(f.fields?.total_value);
        out.push({
          ...base,
          description: product,
          qty_kg: kg,
          unit_price: kg && total ? Math.round((total / kg) * 10000) / 10000 : null,
          hs_code: str(f.fields?.hs_code),
        });
      }
    }
  }
  return out;
}

function off(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b)) * tolerance;
}

export function reconcileManifest(
  manifest: { file_id: string | null; file_name: string; built: boolean; lines: ManifestLine[] },
  invoices: InvoiceLine[],
): ManifestReconciliation {
  const used = new Set<number>();
  const matches: ManifestMatch[] = [];
  const discrepancies: Discrepancy[] = [];
  const manifestCite = (value: unknown) => ({
    file_id: manifest.file_id,
    file_name: manifest.file_name,
    doc_type: 'manifest',
    value: value === null || value === undefined ? '—' : String(value),
  });
  const invoiceCite = (inv: InvoiceLine, value: unknown) => ({
    file_id: inv.file_id,
    file_name: inv.file_name,
    doc_type: 'invoice',
    value: value === null || value === undefined ? '—' : String(value),
  });

  for (const line of manifest.lines) {
    const idx = invoices.findIndex((inv, i) => !used.has(i) && sameGoods(line.name, inv.description));
    if (idx < 0) {
      matches.push({ manifest: line, invoice: null, status: 'no_invoice' });
      if (!manifest.built) {
        discrepancies.push({
          field: 'manifest_line',
          expected: line.name,
          actual: 'немає в інвойсах партій',
          severity: 'warning',
          kind: 'suspected',
          citations: [manifestCite(line.name)],
        });
      }
      continue;
    }
    used.add(idx);
    const inv = invoices[idx]!;
    let status: ManifestMatchStatus = 'ok';
    if (!manifest.built && inv.qty_kg !== null && line.qtyKg > 0 && off(line.qtyKg, inv.qty_kg, QTY_TOLERANCE)) {
      status = 'qty';
      discrepancies.push({
        field: 'manifest_qty',
        expected: `${line.name}: ${line.qtyKg} кг`,
        actual: `${inv.qty_kg} кг (${inv.lot_name})`,
        severity: 'error',
        kind: 'confirmed',
        citations: [manifestCite(line.qtyKg), invoiceCite(inv, inv.qty_kg)],
      });
    } else if (!manifest.built && inv.unit_price !== null && line.unitPrice > 0 && off(line.unitPrice, inv.unit_price, PRICE_TOLERANCE)) {
      status = 'price';
      discrepancies.push({
        field: 'manifest_price',
        expected: `${line.name}: ${line.unitPrice}`,
        actual: `${inv.unit_price} (${inv.lot_name})`,
        severity: 'warning',
        kind: 'confirmed',
        citations: [manifestCite(line.unitPrice), invoiceCite(inv, inv.unit_price)],
      });
    }
    matches.push({ manifest: line, invoice: inv, status });
  }

  invoices.forEach((inv, i) => {
    if (used.has(i)) return;
    matches.push({ manifest: null, invoice: inv, status: 'not_in_manifest' });
    if (!manifest.built) {
      discrepancies.push({
        field: 'manifest_extra',
        expected: 'позиція маніфесту',
        actual: `${inv.description} (${inv.lot_name})`,
        severity: 'warning',
        kind: 'suspected',
        citations: [invoiceCite(inv, inv.description)],
      });
    }
  });

  return { file_id: manifest.file_id, file_name: manifest.file_name, built: manifest.built, matches, discrepancies };
}

function csvCell(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A manifest CSV built from the invoices — the columns the analysis parser reads. */
export function buildManifestCsv(lines: InvoiceLine[]): string {
  const rows = [['Назва товару', 'Кількість, кг', 'Ціна за кг', 'Код УКТ ЗЕД', 'Партія']];
  for (const l of lines) {
    rows.push([l.description, String(l.qty_kg ?? ''), String(l.unit_price ?? ''), l.hs_code ?? '', l.lot_name]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}
