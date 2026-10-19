import { pool, query } from '../db/pool.js';
import type { WorkspaceRow } from '../shipments/workspaceAccess.js';
import { sameCompany } from '../shipments/contextDerive.js';

/**
 * Deterministic document-completeness checklist. Requirements come from
 * `checklist_templates` matched against the workspace's product/incoterm/mode;
 * each requirement's status is resolved from the files actually present (folder
 * hint) and their structured extraction (`document_extractions.doc_type`)
 * — computed by `verdicts.ts`, persisted here:
 *   missing  — no latest file attributable to this requirement
 *   received — a latest file's folder covers it, but it isn't extraction-verified
 *   verified — a latest file has an extraction whose doc_type == requirement
 * Results are persisted to `workspace_checklist_items` and returned.
 */

export type ChecklistStatus = 'missing' | 'received' | 'verified';

export interface ChecklistItem {
  requirement_key: string;
  status: ChecklistStatus;
  source_file_id: string | null;
}

// Folder → document categories it can satisfy (weak "received" signal). The
// merged first folder holds contract/invoice/packing-list, so it covers all
// three; extraction is what promotes them to "verified".
const FOLDER_CATEGORIES: Record<string, string[]> = {
  '01_Contract_Invoice_PackingList': ['contract', 'invoice', 'packing_list'],
  // Merged certificate folder covers both certificate categories.
  '03_Certificates': ['certificate_of_origin', 'quality_certificate'],
  '04_Customs': ['customs_declaration'],
  '05_Transport': ['transport'],
};

export interface LatestFileRow {
  file_id: string;
  folder_name: string | null;
  doc_type: string | null;
  also_contains: string[] | null;
  seller: string | null;
  buyer: string | null;
}

/** Requirement keys from `checklist_templates` that match the shipment's context. */
export async function requiredDocumentTypes(ws: WorkspaceRow): Promise<string[]> {
  const { rows } = await query<{ required_document_types: string[] }>(
    `SELECT required_document_types FROM checklist_templates
     WHERE (product_category IS NULL OR product_category = $1)
       AND (incoterm IS NULL OR incoterm = $2)
       AND (transport_mode IS NULL OR transport_mode = $3)
       AND (contract_type IS NULL OR contract_type = $4)`,
    // Import customs is driven by the incoming (buy-side) Incoterm.
    [ws.product_category, ws.incoterm_in ?? ws.incoterm, ws.transport_mode, ws.contract_type],
  );
  return [...new Set(rows.flatMap((r) => r.required_document_types))];
}

/**
 * `intermediary_agreement` (trilateral) is not a doc_type the extractor emits:
 * it is the CONTRACT one of whose sides is the intermediary (e.g. PRIME FORCE as
 * seller to the importer, or as buyer from the manufacturer). Verified when such
 * a contract is in the package; with no intermediary named yet, any contract
 * counts as "received" (present, sides not yet confirmed).
 */
function resolveIntermediaryAgreement(
  files: LatestFileRow[],
  intermediary: string | null,
): ChecklistItem {
  const contracts = files.filter(
    (f) => f.doc_type === 'contract' || (Array.isArray(f.also_contains) && f.also_contains.includes('contract')),
  );
  const match = intermediary
    ? contracts.find((f) => sameCompany(f.seller, intermediary) || sameCompany(f.buyer, intermediary))
    : undefined;
  if (match) return { requirement_key: 'intermediary_agreement', status: 'verified', source_file_id: match.file_id };
  if (!intermediary && contracts[0]) {
    return { requirement_key: 'intermediary_agreement', status: 'received', source_file_id: contracts[0].file_id };
  }
  return { requirement_key: 'intermediary_agreement', status: 'missing', source_file_id: null };
}

export function resolveItems(
  required: string[],
  files: LatestFileRow[],
  intermediary: string | null = null,
): ChecklistItem[] {
  // Extraction-verified: doc_type → file_id.
  const verified = new Map<string, string>();
  // Folder-covered: category → file_id.
  const received = new Map<string, string>();
  for (const f of files) {
    if (f.doc_type && !verified.has(f.doc_type)) verified.set(f.doc_type, f.file_id);
    // A 2-in-1 file (e.g. invoice+packing list) verifies every type it contains.
    if (Array.isArray(f.also_contains)) {
      for (const t of f.also_contains) if (t && !verified.has(t)) verified.set(t, f.file_id);
    }
    const cats = f.folder_name ? FOLDER_CATEGORIES[f.folder_name] ?? [] : [];
    for (const c of cats) if (!received.has(c)) received.set(c, f.file_id);
  }
  return required.map((key) => {
    if (key === 'intermediary_agreement') return resolveIntermediaryAgreement(files, intermediary);
    if (verified.has(key)) {
      return { requirement_key: key, status: 'verified', source_file_id: verified.get(key)! };
    }
    if (received.has(key)) {
      return { requirement_key: key, status: 'received', source_file_id: received.get(key)! };
    }
    return { requirement_key: key, status: 'missing', source_file_id: null };
  });
}

/** Replaces the persisted checklist items for the shipment (what the sidebar reads). */
export async function persistChecklist(workspaceId: string, items: ChecklistItem[]): Promise<void> {
  // Replace persisted items atomically.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Concurrent recomputes (3 index jobs in one workspace) each DELETE+INSERT;
    // under READ COMMITTED both inserts survived → duplicate checklist items.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('checklist:' || $1))", [workspaceId]);
    await client.query('DELETE FROM workspace_checklist_items WHERE workspace_id = $1', [workspaceId]);
    for (const item of items) {
      await client.query(
        `INSERT INTO workspace_checklist_items
           (workspace_id, requirement_key, status, source_file_id, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [workspaceId, item.requirement_key, item.status, item.source_file_id],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
