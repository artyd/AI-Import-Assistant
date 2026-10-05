import { query } from '../db/pool.js';
import { analyzeParties } from './partyExtraction.js';
import { deriveIncoterms, type DeriveDoc } from './contextDerive.js';

/**
 * Incoming (buy-side) and outgoing (sell-side) Incoterms derived from a
 * workspace's stored extractions. No LLM call. Party-aware: in a trilateral deal
 * the inbound leg is the document the intermediary buys on, the outbound leg the
 * one it sells on (see `deriveIncoterms`). User-editable in the shipment card.
 */

export interface IncotermSuggestion {
  incoterm_in: string | null;
  incoterm_out: string | null;
}

/**
 * Latest extractions of a workspace in a STABLE order (same input → same
 * derivation), optionally with the head of each transport document's Markdown.
 */
export async function loadDeriveDocs(
  workspaceId: string,
  opts: { transportMarkdown?: boolean } = {},
): Promise<DeriveDoc[]> {
  const { rows } = await query<{
    file_name: string | null;
    doc_type: string | null;
    fields: Record<string, unknown> | null;
    markdown: string | null;
  }>(
    `SELECT f.name AS file_name,
            de.extracted_fields->>'doc_type' AS doc_type,
            de.extracted_fields AS fields,
            ${
              opts.transportMarkdown
                ? `CASE WHEN de.extracted_fields->>'doc_type' = 'transport' THEN
                     (SELECT left(string_agg(p.value->>'markdown', E'\\n' ORDER BY p.ord), 4000)
                        FROM file_markdown fm,
                             jsonb_array_elements(fm.pages) WITH ORDINALITY AS p(value, ord)
                       WHERE fm.file_id = f.id)
                   END`
                : 'NULL'
            } AS markdown
     FROM document_extractions de
     JOIN files f ON f.id = de.file_id
     WHERE de.workspace_id = $1 AND f.is_latest = true
     ORDER BY f.created_at, f.name, f.id`,
    [workspaceId],
  );
  return rows.map((r) => ({
    file_name: r.file_name,
    doc_type: r.doc_type,
    fields: r.fields ?? {},
    markdown: r.markdown,
  }));
}

export async function suggestIncoterms(workspaceId: string): Promise<IncotermSuggestion> {
  const [docs, analysis] = await Promise.all([loadDeriveDocs(workspaceId), analyzeParties(workspaceId)]);
  const intermediary = analysis.suggestions.find((s) => s.role === 'intermediary')?.company_name ?? null;
  return deriveIncoterms(docs, analysis.contract_type, intermediary);
}
