import type { Discrepancy } from './reconcile.js';
import type { RegistryFinding } from '../customs/drugRegistry.js';

/**
 * Proactive risk engine. Unlike discrepancies (which only compares invoice/PO/PL
 * figures), this surfaces CURRENT and UPCOMING problems a logistician should act
 * on: expiring/expired certificates, documents still missing for the shipment,
 * numeric mismatches, and delivery-deadline pressure. Pure — computed from the
 * shipment verdict inputs (`verdicts.ts`): extractions, the freshly computed
 * checklist, discrepancies and registry findings. It NEVER invents data; a
 * shipment with no extractions simply yields no risks.
 */

export type RiskSeverity = 'error' | 'warning' | 'info';
export type RiskCategory =
  | 'expiry'
  | 'missing_docs'
  | 'discrepancy'
  | 'deadline'
  | 'registry'
  | 'payment'
  | 'dangerous_goods'
  | 'document_quality';

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
  const t = parseFlexibleDate(dateStr);
  if (t === null) return null;
  return Math.round((t - now) / DAY_MS);
}

export { parseFlexibleDate } from '../lib/dates.js';
import { parseFlexibleDate } from '../lib/dates.js';

const DOC_LABELS: Record<string, string> = {
  other: 'Документ',
  invoice: 'Інвойс',
  packing_list: 'Пакувальний лист',
  contract: 'Контракт',
  certificate_of_origin: 'Сертифікат походження',
  quality_certificate: 'Сертифікат якості',
  customs_declaration: 'Митна декларація',
  transport: 'Транспортний документ',
  intermediary_agreement: 'Договір з посередником',
  veterinary_certificate: 'Ветеринарний сертифікат',
  phytosanitary_certificate: 'Фітосанітарний сертифікат',
  import_license: 'Ліцензія на імпорт',
  precursor_permit: 'Дозвіл на імпорт прекурсорів / контрольованих речовин',
  conformity_document: 'Документ про відповідність техрегламенту',
  dual_use_permit: 'Дозвіл на товари подвійного використання',
};

/** Human labels for reconciliation fields (raw keys never reach the user). */
export const DISCREPANCY_FIELD_LABELS: Record<string, string> = {
  net_weight_kg: 'вага нетто',
  gross_weight_kg: 'вага брутто',
  total_weight_kg: 'загальна вага',
  packages_count: 'кількість місць',
  line_items: 'кількість позицій',
  line_quantity: 'кількість товару',
  line_amount: 'сума по позиції',
  line_hs_code: 'код УКТ ЗЕД по позиції',
  hs_code: 'код УКТ ЗЕД',
  incoterm: 'умови поставки (Incoterms)',
  currency: 'валюта',
  total_value: 'сума',
  country_of_origin: 'країна походження',
  manufacturer: 'виробник',
  registration_number: 'реєстраційний номер',
  markup: 'націнка посередника',
  intermediary: 'посередник',
  seller: 'продавець',
  buyer: 'покупець',
  documents: 'документи',
  instruction: 'виконання інструкції постачальнику',
  // FCL (Збірник) checks, spec 006.
  container_numbers: 'номер контейнера',
  hbl_sum_gross_weight_kg: 'сума ваги брутто HBL проти MBL',
  hbl_sum_packages_count: 'сума місць HBL проти MBL',
  transit_gross_weight_kg: 'вага брутто T1 проти MBL',
  lot_gross_weight_kg: 'вага брутто партії (PL проти HBL)',
  manifest_qty: 'кількість у маніфесті',
  manifest_price: 'ціна в маніфесті',
  manifest_line: 'позиція маніфесту без інвойсу',
  manifest_extra: 'товар поза маніфестом',
  // Document integrity (documentChecks.ts).
  bank_account: 'банківські реквізити',
  bank_accounts: 'банківські реквізити',
  dangerous_goods: 'небезпечний вантаж',
  signed: 'підпис',
  stamped: 'печатка',
  empty_fields: 'порожні поля',
};

export function fieldLabel(field: string): string {
  return DISCREPANCY_FIELD_LABELS[field] ?? field;
}

export function label(key: string): string {
  return DOC_LABELS[key] ?? key;
}

export interface RiskExtraction {
  file_id: string;
  file_name: string;
  doc_type: string | null;
  expiry_date: string | null;
  shipment_date: string | null;
  delivery_deadline: string | null;
  /** Issue date — for a customs declaration, the day the goods were declared. */
  document_date?: string | null;
  /**
   * For a customs declaration: false when it is NOT the Ukrainian import МД (a
   * Chinese / EU export declaration also lands in `customs_declaration`).
   */
  ua_import?: boolean;
}

/** The Ukrainian import МД — the goods are declared (export papers don't count). */
const isUaImport = (r: RiskExtraction): boolean => r.doc_type === 'customs_declaration' && r.ua_import !== false;

// A draft («Health certificate draft.doc») is not the certificate the goods travel with.
const DRAFT_NAME_RX = /draft|чернет|черновик|проект/i;

/**
 * The day certificate validity is judged on. Once the goods are declared (a
 * customs declaration is in the package) that is the declaration day — a
 * certificate that expired months AFTER clearance is history, not a risk (live
 * test «Сборник 18»: a cleared shipment flagged «прострочено, минуло 103 дн.»).
 * null = declared, but the declaration date is unreadable: no expiry verdict.
 */
function validityReference(extractions: RiskExtraction[], now: number): number | null {
  const decl = extractions.filter(isUaImport);
  if (decl.length === 0) return now;
  const dates = decl.map((r) => (r.document_date ? parseFlexibleDate(r.document_date) : null)).filter((t): t is number => t !== null);
  return dates.length ? Math.max(...dates) : null;
}

export interface RiskInput {
  /** Latest extractions of the shipment. */
  extractions: RiskExtraction[];
  /** Requirement keys the checklist marks `missing`, sorted. */
  missing: string[];
  discrepancies: Discrepancy[];
  registry: RegistryFinding[];
  /** Document-integrity risks (documentChecks.ts): bank, dangerous goods, certificates, blank fields. */
  flags?: Risk[];
  now: number;
}

/** The current risk list for a shipment, most severe first. */
export function assessRisks({ extractions, missing, discrepancies, registry, flags = [], now }: RiskInput): Risk[] {
  const risks: Risk[] = [...flags];
  // A customs declaration in the package means the goods have been declared —
  // a passed delivery date is history then, not a pending risk.
  const declared = extractions.some(isUaImport);

  // 1. Expiry / validity of certificates & licences — on the declaration day once
  //    the goods are declared, today otherwise; drafts are not the certificate.
  const ref = validityReference(extractions, now);
  let earliestDeadline: { days: number; name: string } | null = null;
  for (const r of extractions) {
    if (r.expiry_date && ref !== null && !DRAFT_NAME_RX.test(r.file_name)) {
      const d = daysUntil(r.expiry_date, ref);
      if (d !== null) {
        if (d < 0 && declared) {
          risks.push({
            code: 'cert_expired',
            category: 'expiry',
            severity: 'error',
            title: `${label(r.doc_type ?? 'other')} був прострочений на дату митного оформлення`,
            detail: `«${r.file_name}» — дата закінчення ${r.expiry_date}, раніше за дату МД.`,
            source_file_id: r.file_id,
          });
        } else if (declared) {
          // Valid on the declaration day: nothing to act on.
        } else if (d < 0) {
          risks.push({
            code: 'cert_expired',
            category: 'expiry',
            severity: 'error',
            title: `${label(r.doc_type ?? 'other')} прострочено`,
            detail: `«${r.file_name}» — дата закінчення ${r.expiry_date} (минуло ${-d} дн.).`,
            source_file_id: r.file_id,
          });
        } else if (d <= EXPIRY_SOON_DAYS) {
          risks.push({
            code: 'cert_expiring',
            category: 'expiry',
            severity: 'warning',
            title: `${label(r.doc_type ?? 'other')} скоро завершиться`,
            detail: `«${r.file_name}» — дійсний ще ${d} дн. (до ${r.expiry_date}).`,
            source_file_id: r.file_id,
          });
        }
      }
    }
    // Track the nearest delivery DEADLINE for the deadline check below. The
    // shipment date (AWB / dispatch) is when goods left, not a deadline.
    // ('other' = unrelated files — their dates are not this shipment's deadline;
    // their expiry above still matters, e.g. a licence or registration.)
    const dl = r.doc_type && r.doc_type !== 'other' ? r.delivery_deadline : null;
    if (dl) {
      const d = daysUntil(dl, now);
      if (d !== null && (earliestDeadline === null || d < earliestDeadline.days)) {
        earliestDeadline = { days: d, name: r.file_name };
      }
    }
  }

  // 2. Missing required documents (from the computed checklist).
  if (missing.length > 0) {
    risks.push({
      code: 'docs_missing',
      category: 'missing_docs',
      severity: 'warning',
      title: `Бракує документів: ${missing.length}`,
      detail: `Ще не отримано: ${missing.map((m) => label(m)).join(', ')}.`,
      source_file_id: null,
    });
  }

  // 3. Numeric / field discrepancies (from the reconciliation engine).
  for (const d of discrepancies) {
    risks.push({
      code: `discrepancy_${d.field}`,
      category: 'discrepancy',
      severity: d.severity === 'info' ? 'info' : d.severity,
      title: `Розбіжність: ${fieldLabel(d.field)}`,
      // Evidence: the files and values that produced the finding, so the agent
      // can check it against the documents (there is no dismiss mechanism).
      detail:
        `${d.expected} → ${d.actual}` +
        (d.citations.length
          ? ` [джерела: ${d.citations.map((c) => `${c.file_name ?? c.doc_type}=${c.value}`).join('; ')}]`
          : ''),
      source_file_id: d.citations[0]?.file_id ?? null,
    });
  }

  // 3b. Drug-registry cross-check (Phase 6): validity, manufacturer vs registry,
  //     MAH present in documents. Advisory — a specialist confirms.
  for (const r of registry) {
    risks.push({
      code: r.code,
      category: 'registry',
      severity: r.severity,
      title: r.title,
      detail: r.detail,
      source_file_id: null,
    });
  }

  // 4. Delivery-deadline pressure (only meaningful while docs are incomplete).
  if (earliestDeadline && missing.length > 0 && !declared) {
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
