import { query } from '../db/pool.js';
import type { ExtractedFields } from './extraction/extractFields.js';
import { reconcile, type ReconcileDoc } from './reconcile.js';

/**
 * Workspace-scoped cross-document reconciliation. Reads the latest structured
 * extractions for the invoice / purchase-order / packing-list / contract of a
 * workspace and hands them to the pure `reconcile()` core (`reconcile.ts`), which
 * does the actual comparison. It NEVER re-reads raw document text — findings are a
 * pure function of `document_extractions`.
 *
 * The ranking contract (🔴 confirmed with two citations / 🟡 suspected) lives in
 * `reconcile.ts`; see there for the full rationale.
 */

// Re-export the finding types so existing consumers keep importing them from here.
export type {
  Severity,
  FlagKind,
  DiscrepancyCitation,
  Discrepancy,
} from './reconcile.js';

type Fields = Partial<ExtractedFields> & Record<string, unknown>;

type Row = { file_id: string | null; file_name: string | null; doc_type: string | null; fields: Fields };

export async function computeDiscrepancies(workspaceId: string): Promise<
  import('./reconcile.js').Discrepancy[]
> {
  const { rows } = await query<Row>(
    `SELECT f.id   AS file_id,
            f.name AS file_name,
            de.extracted_fields->>'doc_type' AS doc_type,
            de.extracted_fields AS fields
     FROM document_extractions de
     JOIN files f ON f.id = de.file_id
     WHERE de.workspace_id = $1 AND f.is_latest = true`,
    [workspaceId],
  );

  const docs: ReconcileDoc[] = rows.map((r) => ({
    file_id: r.file_id,
    file_name: r.file_name,
    doc_type: r.doc_type,
    fields: r.fields,
  }));

  return reconcile(docs);
}
