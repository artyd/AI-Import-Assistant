import { query } from '../db/pool.js';
import type { WorkspaceRow, WorkspaceStatus } from '../shipments/workspaceAccess.js';
import { latestApproved, type InstructionVersion } from '../instruction/store.js';
import { registryChecksForDocs, type RegistryFinding } from '../customs/drugRegistry.js';
import { FEED_SQL_RX, VET_SQL_RX } from './feed.js';
import { requiredDocumentTypes, resolveItems, type ChecklistItem, type LatestFileRow } from './checklist.js';
import { findDiscrepancies, type Discrepancy } from './discrepancies.js';
import type { ReconcileDoc } from './reconcile.js';
import { assessRisks, type Risk } from './risks.js';
import { documentRisks } from './documentChecks.js';

/**
 * Shipment verdicts: completeness (checklist), discrepancies, risks and the
 * derived pipeline status — all deterministic functions of ONE snapshot of the
 * shipment (ADR-0003). The snapshot is loaded once (`loadShipmentSnapshot`, the
 * only Postgres seam); `computeVerdicts` is pure. Persisting the checklist and
 * advancing the status is `refreshWorkspaceState` (`shipments/status.ts`).
 */

/** One latest file of the shipment; `fields` is null when it has no extraction. */
export interface ShipmentFile {
  file_id: string;
  file_name: string;
  folder_name: string | null;
  fields: Record<string, unknown> | null;
  /** The text says the goods are animal feed («feed grade», «кормов…»). */
  feed_goods?: boolean;
  /** The text is (or contains) a veterinary / health certificate. */
  vet_certificate?: boolean;
}

export interface ShipmentSnapshot {
  ws: WorkspaceRow;
  /** Requirement keys from the checklist templates matching the shipment. */
  required: string[];
  /** Latest files in a stable order (created_at, name, id). */
  files: ShipmentFile[];
  /** First named intermediary party, if any. */
  intermediary: string | null;
  approvedInstruction: InstructionVersion | null;
  registry: RegistryFinding[];
}

export interface ShipmentVerdicts {
  checklist: ChecklistItem[];
  discrepancies: Discrepancy[];
  risks: Risk[];
  /** Status the verdicts imply (before the forward-only rule). */
  derivedStatus: WorkspaceStatus;
}

/** `->>` semantics: strings as-is, other JSON values as their JSON text. */
function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function docType(f: ShipmentFile): string | null {
  return f.fields ? text(f.fields.doc_type) : null;
}

export async function loadShipmentSnapshot(ws: WorkspaceRow): Promise<ShipmentSnapshot> {
  const [required, { rows: files }, { rows: inter }, approvedInstruction] = await Promise.all([
    requiredDocumentTypes(ws),
    query<ShipmentFile>(
      `SELECT f.id AS file_id, f.name AS file_name, fo.name AS folder_name,
              de.extracted_fields AS fields,
              EXISTS (SELECT 1 FROM document_sections ds WHERE ds.file_id = f.id AND ds.text ~* $2) AS feed_goods,
              EXISTS (SELECT 1 FROM document_sections ds WHERE ds.file_id = f.id AND ds.text ~* $3) AS vet_certificate
       FROM files f
       LEFT JOIN folders fo ON fo.id = f.folder_id
       LEFT JOIN document_extractions de ON de.file_id = f.id
       WHERE f.workspace_id = $1 AND f.is_latest = true
       -- Stable order: when several files share a doc_type the reconciler and the
       -- checklist pick among them, and the verdict must not change between calls.
       ORDER BY f.created_at, f.name, f.id`,
      [ws.id, FEED_SQL_RX, VET_SQL_RX],
    ),
    query<{ company_name: string }>(
      `SELECT company_name FROM parties
       WHERE workspace_id = $1 AND role = 'intermediary' AND company_name <> ''
       ORDER BY created_at LIMIT 1`,
      [ws.id],
    ),
    latestApproved(ws.id),
  ]);

  // Drug-registry cross-check over the shipment's own documents ('other' =
  // unrelated files, e.g. another product's registration). Advisory — never
  // fails the verdicts.
  let registry: RegistryFinding[] = [];
  try {
    registry = await registryChecksForDocs(
      files
        .filter((f) => f.fields && (docType(f) ?? 'other') !== 'other')
        .map((f) => ({ file_name: f.file_name, fields: f.fields! })),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Registry check failed for workspace ${ws.id}:`, (err as Error).message);
  }

  return { ws, required, files, intermediary: inter[0]?.company_name ?? null, approvedInstruction, registry };
}

/**
 * Derived customs-pipeline status. Thresholds are intentionally simple — refine
 * after seeing real data:
 *   draft            — intake not yet complete
 *   docs_in_progress — required documents still missing (or unresolved errors)
 *   docs_complete    — every required doc present, no error-level discrepancies
 *   customs_ready    — every required doc extraction-verified, no error discrepancies
 */
export function deriveWorkspaceStatus(
  ws: Pick<WorkspaceRow, 'intake_complete'>,
  checklist: ChecklistItem[],
  discrepancies: Discrepancy[],
): WorkspaceStatus {
  if (!ws.intake_complete) return 'draft';
  if (checklist.length === 0) return 'docs_in_progress';

  const anyMissing = checklist.some((i) => i.status === 'missing');
  const hasErrors = discrepancies.some((d) => d.severity === 'error');
  if (anyMissing) return 'docs_in_progress';

  const allVerified = checklist.every((i) => i.status === 'verified');
  if (allVerified && !hasErrors) return 'customs_ready';
  if (!hasErrors) return 'docs_complete';
  return 'docs_in_progress';
}

// Feed goods need a veterinary (health) certificate; the baseline template knows
// nothing about the product, and the quality-certificate slot used to swallow it
// (live test «Лизин»: CoA counted, the unsigned health certificate never flagged).
const DRAFT_NAME_RX = /draft|чернет|черновик|проект/i;
const FEED_CATEGORY_RX = /feed|корм/i;

/**
 * The «ветеринарний сертифікат» requirement for feed goods: null when the goods
 * are not feed. 'received' when a non-draft file reads as a health certificate
 * (signature and stamp still need a human eye), else 'missing'.
 */
export function veterinaryItem(s: Pick<ShipmentSnapshot, 'ws' | 'files'>): ChecklistItem | null {
  const feed = s.files.some((f) => f.feed_goods) || FEED_CATEGORY_RX.test(s.ws.product_category ?? '');
  if (!feed) return null;
  const cert = s.files.find((f) => f.vet_certificate && !DRAFT_NAME_RX.test(f.file_name));
  return cert
    ? { requirement_key: 'veterinary_certificate', status: 'received', source_file_id: cert.file_id }
    : { requirement_key: 'veterinary_certificate', status: 'missing', source_file_id: null };
}

/** Pure: snapshot → every verdict. `now` drives the expiry/deadline windows. */
export function computeVerdicts(s: ShipmentSnapshot, now: number = Date.now()): ShipmentVerdicts {
  const checklistRows: LatestFileRow[] = s.files.map((f) => ({
    file_id: f.file_id,
    folder_name: f.folder_name,
    doc_type: docType(f),
    also_contains: (f.fields?.also_contains as string[] | null | undefined) ?? null,
    seller: f.fields ? text(f.fields.seller) : null,
    buyer: f.fields ? text(f.fields.buyer) : null,
  }));
  const checklist = s.required.length === 0 ? [] : resolveItems(s.required, checklistRows, s.intermediary);
  const vet = veterinaryItem(s);
  if (vet && s.required.length > 0 && !checklist.some((i) => i.requirement_key === vet.requirement_key)) checklist.push(vet);

  const extracted = s.files.filter((f) => f.fields !== null);
  const docs: ReconcileDoc[] = extracted.map((f) => ({
    file_id: f.file_id,
    file_name: f.file_name,
    doc_type: docType(f),
    fields: f.fields!,
  }));
  const discrepancies = findDiscrepancies(docs, {
    ws: s.ws,
    intermediary: s.intermediary,
    approvedInstruction: s.approvedInstruction,
  });

  const risks = assessRisks({
    extractions: extracted.map((f) => ({
      file_id: f.file_id,
      file_name: f.file_name,
      doc_type: docType(f),
      expiry_date: text(f.fields!.expiry_date),
      shipment_date: text(f.fields!.shipment_date),
      delivery_deadline: text(f.fields!.delivery_deadline),
    })),
    missing: checklist
      .filter((i) => i.status === 'missing')
      .map((i) => i.requirement_key)
      .sort(),
    discrepancies,
    registry: s.registry,
    // Bank, dangerous-goods, certificate and blank-field flags (documentChecks.ts).
    flags: documentRisks(docs.map((d, i) => ({ ...d, vet_certificate: extracted[i]!.vet_certificate ?? false }))),
    now,
  });

  return { checklist, discrepancies, risks, derivedStatus: deriveWorkspaceStatus(s.ws, checklist, discrepancies) };
}

/** Read-only verdicts for a shipment (nothing persisted). */
export async function shipmentVerdicts(ws: WorkspaceRow): Promise<ShipmentVerdicts> {
  if (ws.kind === 'fcl') {
    // An FCL (spec 006): the FCL checklist, with every lot's findings labelled by lot.
    const { loadFclVerdicts, flattenFcl } = await import('../shipments/fclState.js');
    const v = await loadFclVerdicts(ws);
    const { discrepancies, risks } = flattenFcl(v);
    const checklist = v.level.checklist.map((i) => ({ requirement_key: i.requirement_key, status: i.status, source_file_id: i.source_file_id }));
    return { checklist, discrepancies, risks, derivedStatus: v.level.derivedStatus };
  }
  return computeVerdicts(await loadShipmentSnapshot(ws));
}
