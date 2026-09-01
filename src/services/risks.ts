import { query } from '../db/pool.js';
import type { WorkspaceRow } from './workspaceAccess.js';
import { computeDiscrepancies } from './discrepancies.js';

/**
 * Proactive risk engine. Unlike discrepancies (which only compares invoice/PO/PL
 * figures), this surfaces CURRENT and UPCOMING problems a logistician should act
 * on: expiring/expired certificates, documents still missing for the shipment,
 * numeric mismatches, and delivery-deadline pressure. Deterministic — computed
 * from `document_extractions`, the persisted checklist, and intake context. It
 * NEVER invents data; a shipment with no extractions simply yields no risks.
 */

export type RiskSeverity = 'error' | 'warning' | 'info';
export type RiskCategory = 'expiry' | 'missing_docs' | 'discrepancy' | 'deadline';

export interface Risk {
  code: string;
  category: RiskCategory;
  severity: RiskSeverity;
  title: string;
  detail: string;
  source_file_id: string | null;
}

// Windows for "soon" warnings.
const EXPIRY_SOON_DAYS = 30;
const DEADLINE_SOON_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(dateStr: string, now: number): number | null {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.round((t - now) / DAY_MS);
}

const DOC_LABELS: Record<string, string> = {
  invoice: 'Інвойс',
  purchase_order: 'Замовлення (PO)',
  packing_list: 'Пакувальний лист',
  contract: 'Контракт',
  certificate_of_origin: 'Сертифікат походження',
  quality_certificate: 'Сертифікат якості',
  customs_declaration: 'Митна декларація',
  transport: 'Транспортний документ',
  intermediary_agreement: 'Договір з посередником',
};

function label(key: string): string {
  return DOC_LABELS[key] ?? key;
}

interface ExtractionRow {
  file_id: string;
  file_name: string;
  doc_type: string | null;
  expiry_date: string | null;
  shipment_date: string | null;
  delivery_deadline: string | null;
}

/** Computes the current risk list for a workspace. Read-only (no persistence). */
export async function computeRisks(ws: WorkspaceRow): Promise<Risk[]> {
  const now = Date.now();
  const risks: Risk[] = [];

  const { rows: extractions } = await query<ExtractionRow>(
    `SELECT de.file_id,
            f.name AS file_name,
            de.extracted_fields->>'doc_type' AS doc_type,
            de.extracted_fields->>'expiry_date' AS expiry_date,
            de.extracted_fields->>'shipment_date' AS shipment_date,
            de.extracted_fields->>'delivery_deadline' AS delivery_deadline
     FROM document_extractions de
     JOIN files f ON f.id = de.file_id
     WHERE de.workspace_id = $1 AND f.is_latest = true`,
    [ws.id],
  );

  // 1. Expiry / validity of certificates & licences.
  let earliestDeadline: { days: number; name: string } | null = null;
  for (const r of extractions) {
    if (r.expiry_date) {
      const d = daysUntil(r.expiry_date, now);
      if (d !== null) {
        if (d < 0) {
          risks.push({
            code: 'cert_expired',
            category: 'expiry',
            severity: 'error',
            title: `${label(r.doc_type ?? 'документ')} прострочено`,
            detail: `«${r.file_name}» — дата закінчення ${r.expiry_date} (минуло ${-d} дн.).`,
            source_file_id: r.file_id,
          });
        } else if (d <= EXPIRY_SOON_DAYS) {
          risks.push({
            code: 'cert_expiring',
            category: 'expiry',
            severity: 'warning',
            title: `${label(r.doc_type ?? 'документ')} скоро завершиться`,
            detail: `«${r.file_name}» — дійсний ще ${d} дн. (до ${r.expiry_date}).`,
            source_file_id: r.file_id,
          });
        }
      }
    }
    // Track the nearest delivery deadline for the deadline check below.
    const dl = r.delivery_deadline ?? r.shipment_date;
    if (dl) {
      const d = daysUntil(dl, now);
      if (d !== null && (earliestDeadline === null || d < earliestDeadline.days)) {
        earliestDeadline = { days: d, name: r.file_name };
      }
    }
  }

  // 2. Missing required documents (from the persisted checklist).
  const { rows: missing } = await query<{ requirement_key: string }>(
    `SELECT requirement_key FROM workspace_checklist_items
     WHERE workspace_id = $1 AND status = 'missing' ORDER BY requirement_key`,
    [ws.id],
  );
  if (missing.length > 0) {
    risks.push({
      code: 'docs_missing',
      category: 'missing_docs',
      severity: 'warning',
      title: `Бракує документів: ${missing.length}`,
      detail: `Ще не отримано: ${missing.map((m) => label(m.requirement_key)).join(', ')}.`,
      source_file_id: null,
    });
  }

  // 3. Numeric / field discrepancies (reuse the reconciliation engine).
  const discrepancies = await computeDiscrepancies(ws.id);
  for (const d of discrepancies) {
    risks.push({
      code: `discrepancy_${d.field}`,
      category: 'discrepancy',
      severity: d.severity === 'info' ? 'info' : d.severity,
      title: `Розбіжність: ${d.field}`,
      detail: `${d.expected} → ${d.actual}`,
      source_file_id: null,
    });
  }

  // 4. Delivery-deadline pressure (only meaningful while docs are incomplete).
  if (earliestDeadline && missing.length > 0) {
    const { days } = earliestDeadline;
    if (days < 0) {
      risks.push({
        code: 'deadline_passed',
        category: 'deadline',
        severity: 'error',
        title: 'Термін поставки минув, а пакет документів неповний',
        detail: `Крайній термін минув ${-days} дн. тому, ще бракує документів (${missing.length}).`,
        source_file_id: null,
      });
    } else if (days <= DEADLINE_SOON_DAYS) {
      risks.push({
        code: 'deadline_soon',
        category: 'deadline',
        severity: 'warning',
        title: 'Наближається термін поставки',
        detail: `До терміну ${days} дн., але ще бракує документів (${missing.length}).`,
        source_file_id: null,
      });
    }
  }

  // Most severe first.
  const rank: Record<RiskSeverity, number> = { error: 0, warning: 1, info: 2 };
  return risks.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
