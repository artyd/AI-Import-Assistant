import { pool, query } from '../db/pool.js';
import type { WorkspaceRow } from './workspaceAccess.js';

/**
 * Deterministic document-completeness checklist. Requirements come from
 * `checklist_templates` matched against the workspace's product/incoterm/mode;
 * each requirement's status is resolved from the files actually present (folder
 * hint) and their structured extraction (`document_extractions.doc_type`):
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
  '02_PO': ['purchase_order'],
  // Merged certificate folder covers both certificate categories.
  '03_Certificates': ['certificate_of_origin', 'quality_certificate'],
  '04_Customs': ['customs_declaration'],
  '05_Transport': ['transport'],
};

interface LatestFileRow {
  file_id: string;
  folder_name: string | null;
  doc_type: string | null;
  also_contains: string[] | null;
}

async function requiredKeys(ws: WorkspaceRow): Promise<string[]> {
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

function resolveItems(required: string[], files: LatestFileRow[]): ChecklistItem[] {
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
    if (verified.has(key)) {
      return { requirement_key: key, status: 'verified', source_file_id: verified.get(key)! };
    }
    if (received.has(key)) {
      return { requirement_key: key, status: 'received', source_file_id: received.get(key)! };
    }
    return { requirement_key: key, status: 'missing', source_file_id: null };
  });
}

/** Computes the checklist and replaces the persisted items for the workspace. */
export async function computeChecklist(ws: WorkspaceRow): Promise<ChecklistItem[]> {
  const required = await requiredKeys(ws);
  if (required.length === 0) return [];

  const { rows: files } = await query<LatestFileRow>(
    `SELECT f.id AS file_id, fo.name AS folder_name,
            de.extracted_fields->>'doc_type' AS doc_type,
            de.extracted_fields->'also_contains' AS also_contains
     FROM files f
     LEFT JOIN folders fo ON fo.id = f.folder_id
     LEFT JOIN document_extractions de ON de.file_id = f.id
     WHERE f.workspace_id = $1 AND f.is_latest = true`,
    [ws.id],
  );

  const items = resolveItems(required, files);

  // Replace persisted items atomically.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM workspace_checklist_items WHERE workspace_id = $1', [ws.id]);
    for (const item of items) {
      await client.query(
        `INSERT INTO workspace_checklist_items
           (workspace_id, requirement_key, status, source_file_id, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [ws.id, item.requirement_key, item.status, item.source_file_id],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return items;
}

/** Seeds checklist items the first time intake completes (idempotent recompute). */
export async function seedChecklistItems(ws: WorkspaceRow): Promise<ChecklistItem[]> {
  return computeChecklist(ws);
}
