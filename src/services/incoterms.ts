import { query } from '../db/pool.js';

/**
 * Best-effort derivation of the incoming (buy-side) and outgoing (sell-side)
 * Incoterms from a workspace's stored document extractions. No LLM call — reads
 * `document_extractions`. Heuristic, user-editable in the shipment card:
 *   - incoming = the Incoterm on the invoice → else PO → else a contract → else any
 *   - outgoing = a DIFFERENT Incoterm seen on another document (re-sale leg), else null
 * A single-Incoterm shipment yields incoterm_in only.
 */

export interface IncotermSuggestion {
  incoterm_in: string | null;
  incoterm_out: string | null;
}

interface Row {
  doc_type: string | null;
  incoterm: string | null;
}

export async function suggestIncoterms(workspaceId: string): Promise<IncotermSuggestion> {
  const { rows } = await query<Row>(
    `SELECT de.extracted_fields->>'doc_type' AS doc_type,
            de.extracted_fields->>'incoterm' AS incoterm
     FROM document_extractions de
     JOIN files f ON f.id = de.file_id
     WHERE de.workspace_id = $1 AND f.is_latest = true
       AND de.extracted_fields->>'incoterm' IS NOT NULL`,
    [workspaceId],
  );

  const norm = (s: string): string => s.trim().toUpperCase();
  const byType = new Map<string, string>();
  const all: string[] = [];
  for (const r of rows) {
    if (!r.incoterm) continue;
    const term = norm(r.incoterm);
    all.push(term);
    const key = r.doc_type ?? 'other';
    if (!byType.has(key)) byType.set(key, term);
  }
  if (all.length === 0) return { incoterm_in: null, incoterm_out: null };

  const incoterm_in =
    byType.get('invoice') ??
    byType.get('purchase_order') ??
    byType.get('contract') ??
    all[0]!;

  const outgoing = all.find((t) => t !== incoterm_in) ?? null;
  return { incoterm_in, incoterm_out: outgoing };
}
