import { query } from '../db/pool.js';

/**
 * Aggregates party candidates from a workspace's already-stored document
 * extractions into deduped suggestions. This makes NO new LLM call — it reuses
 * `document_extractions` populated by the indexing worker. The result is a
 * suggestion the user reviews/edits before saving; it never writes to `parties`.
 */

export interface PartySuggestion {
  role: string;
  company_name: string;
  country: string | null;
  source_files: string[];
  confidence: number; // 0..1, corroboration across documents
}

interface ExtractionRow {
  file_name: string;
  fields: Record<string, unknown>;
}

interface Candidate {
  role: string;
  company_name: string;
  country: string | null;
  sources: Set<string>;
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Suggests a deduped parties set from stored extractions (no LLM call). */
export async function suggestParties(workspaceId: string): Promise<PartySuggestion[]> {
  const { rows } = await query<ExtractionRow>(
    `SELECT f.name AS file_name, de.extracted_fields AS fields
     FROM document_extractions de JOIN files f ON f.id = de.file_id
     WHERE de.workspace_id = $1 AND f.is_latest = true`,
    [workspaceId],
  );
  const totalDocs = rows.length || 1;

  const byKey = new Map<string, Candidate>();
  const add = (name: string | null, role: string, country: string | null, source: string): void => {
    if (!name) return;
    const key = norm(name);
    if (!key) return;
    const existing = byKey.get(key);
    if (existing) {
      existing.sources.add(source);
      if (!existing.country && country) existing.country = country;
    } else {
      byKey.set(key, { role, company_name: name, country, sources: new Set([source]) });
    }
  };

  for (const r of rows) {
    const f = r.fields ?? {};
    const src = r.file_name;
    // Structured parties (enriched extraction).
    const parties = Array.isArray(f.parties) ? (f.parties as Record<string, unknown>[]) : [];
    for (const p of parties) {
      add(str(p.name), str(p.role) ?? 'intermediary', str(p.country), src);
    }
    // Legacy scalar fields (best-effort role mapping — heuristic, user-editable).
    add(str(f.seller), 'supplier', str(f.country_of_origin), src);
    add(str(f.buyer), 'our_company', null, src);
  }

  return [...byKey.values()]
    .map((c) => ({
      role: c.role,
      company_name: c.company_name,
      country: c.country,
      source_files: [...c.sources],
      confidence: Math.min(1, c.sources.size / totalDocs),
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Heuristic party-count → contract_type suggestion from the deduped set.
 * 2 distinct parties → bilateral; 3+ → trilateral; otherwise null (weak signal).
 * User-editable; does NOT affect Incoterms logic.
 */
export function suggestContractType(
  suggestions: PartySuggestion[],
): 'bilateral' | 'trilateral' | null {
  const distinct = new Set(suggestions.map((s) => norm(s.company_name))).size;
  if (distinct >= 3) return 'trilateral';
  if (distinct === 2) return 'bilateral';
  return null;
}
