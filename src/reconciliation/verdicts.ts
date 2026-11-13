import { query } from '../db/pool.js';
import type { WorkspaceRow, WorkspaceStatus } from '../shipments/workspaceAccess.js';
import { latestApproved, type InstructionVersion } from '../instruction/store.js';
import { registryChecksForDocs, type RegistryFinding } from '../customs/drugRegistry.js';
import { FEED_SQL_RX, VET_SQL_RX, isFeedEvidence } from './feed.js';
import { loadCachedRequirements } from '../customs/hsRequirementsCache.js';
import {
  HS_REQUIREMENT_KEYS,
  REQUIREMENT_RX_PARAMS,
  hsCodesOf,
  requirementHitsSql,
  type CachedHsRequirements,
  type HsRequirementKey,
} from '../customs/qdproRequirements.js';
import { requiredDocumentTypes, resolveItems, type ChecklistItem, type LatestFileRow } from './checklist.js';
import { findDiscrepancies, type Discrepancy } from './discrepancies.js';
import { isLikelyDraft, type ReconcileDoc } from './reconcile.js';
import { assessRisks, type Risk } from './risks.js';
import { documentRisks } from './documentChecks.js';
import { isImportDeclaration } from './fcl.js';
import { decorateFindings, type TriageRow } from './fingerprint.js';
import { loadTriage } from './triage.js';

/**
 * A customs declaration that is plainly NOT the Ukrainian import МД: a Chinese
 * export declaration (报关单 / CHN…), an EU export MRN (26DE…), a file named
 * «export». Unknown stays an МД (the old behaviour).
 */
export function isForeignDeclaration(f: Pick<ShipmentFile, 'file_id' | 'file_name' | 'folder_name' | 'fields'>): boolean {
  if (isImportDeclaration({ file_id: f.file_id, file_name: f.file_name, file_type: '', folder_name: f.folder_name, lot_id: null, fields: f.fields })) return false;
  const no = text(f.fields?.transport_doc_number) ?? text(f.fields?.registration_number) ?? '';
  return /export|експорт|экспорт|报关|出口|\bCHN\d/i.test(`${f.file_name} ${no}`) || /^\d{2}(?!UA)[A-Z]{2}[A-Z0-9]{10,}$/i.test(no.replace(/\s+/g, ''));
}

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
  /** Requirement keys (qdpro measures) whose document this file's text reads as. */
  requirement_hits?: string[];
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
  /**
   * Cached qdpro import requirements (`hs_requirements`) for the codes in the
   * files' extractions. `computeVerdicts` uses the entries whose code a file of
   * THIS snapshot carries, so an FCL can pass one list for every lot.
   */
  hsRequirements?: CachedHsRequirements[];
  /** The user's decisions on findings (spec 011); decided findings carry `triage`. */
  triage?: TriageRow[];
  /** The lot's name in an FCL — part of its findings' fingerprints. */
  lotName?: string;
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

/**
 * УКТ ЗЕД codes that describe THIS shipment's goods: unrelated files (`other`,
 * e.g. another product's registration) and drafts don't bring their codes'
 * import requirements in.
 */
export function shipmentHsCodes(files: Pick<ShipmentFile, 'file_name' | 'fields'>[]): string[] {
  return files
    .filter((f) => (docType(f as ShipmentFile) ?? 'other') !== 'other' && !DRAFT_NAME_RX.test(f.file_name) && !isLikelyDraft(f.file_name))
    .flatMap((f) => hsCodesOf(f.fields));
}

export async function loadShipmentSnapshot(ws: WorkspaceRow): Promise<ShipmentSnapshot> {
  const [required, { rows: files }, { rows: inter }, approvedInstruction] = await Promise.all([
    requiredDocumentTypes(ws),
    query<ShipmentFile>(
      `SELECT f.id AS file_id, f.name AS file_name, fo.name AS folder_name,
              de.extracted_fields AS fields,
              EXISTS (SELECT 1 FROM document_sections ds WHERE ds.file_id = f.id AND ds.text ~* $2) AS feed_goods,
              EXISTS (SELECT 1 FROM document_sections ds WHERE ds.file_id = f.id AND ds.text ~* $3) AS vet_certificate,
              ${requirementHitsSql(4, 5)}
       FROM files f
       LEFT JOIN folders fo ON fo.id = f.folder_id
       LEFT JOIN document_extractions de ON de.file_id = f.id
       WHERE f.workspace_id = $1 AND f.is_latest = true
       -- Stable order: when several files share a doc_type the reconciler and the
       -- checklist pick among them, and the verdict must not change between calls.
       ORDER BY f.created_at, f.name, f.id`,
      [ws.id, FEED_SQL_RX, VET_SQL_RX, ...REQUIREMENT_RX_PARAMS],
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

  // Official per-code requirements, from the cache only (no network here).
  let hsRequirements: CachedHsRequirements[] = [];
  try {
    hsRequirements = await loadCachedRequirements([...new Set(shipmentHsCodes(files))]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`HS requirements load failed for workspace ${ws.id}:`, (err as Error).message);
  }

  // The user's decisions on findings (best-effort: without them every finding is open).
  let triage: TriageRow[] = [];
  try {
    triage = (await loadTriage(ws.id)) ?? [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Triage load failed for workspace ${ws.id}:`, (err as Error).message);
  }

  return { ws, required, files, intermediary: inter[0]?.company_name ?? null, approvedInstruction, registry, hsRequirements, triage };
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
  // A finding the user decided («Не проблема» / «Вирішено») no longer blocks.
  const hasErrors = discrepancies.some((d) => d.severity === 'error' && !d.triage);
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
  const feed =
    s.files.some((f) => f.feed_goods && isFeedEvidence(docType(f), f.file_name)) ||
    FEED_CATEGORY_RX.test(s.ws.product_category ?? '');
  if (!feed) return null;
  const cert = s.files.find((f) => f.vet_certificate && !DRAFT_NAME_RX.test(f.file_name));
  const basis = 'товар кормового призначення';
  return cert
    ? { requirement_key: 'veterinary_certificate', status: 'received', source_file_id: cert.file_id, basis }
    : { requirement_key: 'veterinary_certificate', status: 'missing', source_file_id: null, basis };
}

// Papers that LIST the documents a deal needs (a contract's «documents to be
// provided», an invoice note) are not the documents themselves.
const LISTING_DOC_TYPES = new Set(['invoice', 'packing_list', 'contract', 'customs_declaration', 'transport']);

/**
 * Requirements the official qdpro measures for the snapshot's УКТ ЗЕД codes add
 * (cached in `hs_requirements`). 'received' when a non-draft file is that
 * document — its doc_type is the key, or its text reads as it and it is not a
 * listing paper — else 'missing'. `basis` names the code(s) for the agent.
 */
export function hsRequirementItems(s: Pick<ShipmentSnapshot, 'files' | 'hsRequirements'>): ChecklistItem[] {
  if (!s.hsRequirements || s.hsRequirements.length === 0) return [];
  const codes = new Set(shipmentHsCodes(s.files));
  const byKey = new Map<HsRequirementKey, string[]>();
  for (const c of s.hsRequirements) {
    if (!codes.has(c.hs_code)) continue;
    for (const r of c.requirements) {
      // A conditional measure (precursor permit only for listed substances, a
      // risk-profile techregulation check, vet control only for veterinary use)
      // is not a document every shipment of the code must carry.
      if (r.conditional) continue;
      const list = byKey.get(r.key) ?? [];
      if (!list.includes(c.hs_code)) list.push(c.hs_code);
      byKey.set(r.key, list);
    }
  }
  return HS_REQUIREMENT_KEYS.filter((k) => byKey.has(k)).map((key) => {
    const forCodes = byKey.get(key)!.sort();
    const basis = `вимога qdpro для ${forCodes.length > 1 ? 'кодів' : 'коду'} ${forCodes.join(', ')}`;
    const file = s.files.find((f) => {
      if (DRAFT_NAME_RX.test(f.file_name)) return false;
      const type = docType(f);
      if (type === key) return true;
      const reads = (f.requirement_hits ?? []).includes(key) || (key === 'veterinary_certificate' && f.vet_certificate === true);
      return reads && !LISTING_DOC_TYPES.has(type ?? '');
    });
    return file
      ? { requirement_key: key, status: 'received' as const, source_file_id: file.file_id, basis }
      : { requirement_key: key, status: 'missing' as const, source_file_id: null, basis };
  });
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
  // Official measures for the goods' УКТ ЗЕД codes (qdpro). One row per key: a
  // requirement already listed (e.g. the feed-based veterinary certificate)
  // keeps its status and gains the qdpro basis.
  if (s.required.length > 0) {
    for (const item of hsRequirementItems(s)) {
      const existing = checklist.find((i) => i.requirement_key === item.requirement_key);
      if (!existing) checklist.push(item);
      else existing.basis = existing.basis ? `${existing.basis}; ${item.basis}` : item.basis;
    }
  }

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
      document_date: text(f.fields!.document_date),
      ua_import: docType(f) === 'customs_declaration' ? !isForeignDeclaration(f) : undefined,
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

  decorateFindings(discrepancies, risks, s.triage, s.lotName);
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
