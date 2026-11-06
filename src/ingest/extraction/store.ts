import { query } from '../../db/pool.js';
import { config } from '../../lib/config.js';
import type { MarkdownPage } from '../markdown/format.js';
import {
  correctLabelDocType,
  extractFieldsFromMarkdown,
  type ExtractedFields,
  type ExtractionResult,
} from './extractFields.js';

/**
 * The extraction step shared by the indexing worker and the re-extraction CLI
 * (`reindexExtraction.ts`): stored Markdown pages → fields → one
 * `document_extractions` row. Callers own the `shipmentChanged` report.
 */

/**
 * True when an extraction carries at least one real signal. A forced-tool call
 * (tool_choice) essentially always returns a non-null object, so "vision produced
 * garbage/near-empty" was previously indistinguishable from "good data" and got
 * marked `ok`. This gate downgrades an all-null extraction to no_fields/unreadable
 * so it reaches the manual-verification screen instead of silently looking read.
 */
export function extractionIsSubstantive(f: ExtractedFields): boolean {
  const backbone = [
    f.invoice_number, f.contract_number, f.po_number, f.total_value, f.currency,
    f.hs_code, f.country_of_origin, f.buyer, f.seller, f.incoterm, f.manufacturer,
    f.registration_number, f.document_date, f.net_weight_kg, f.gross_weight_kg,
    f.total_weight_kg, f.packages_count,
  ];
  const hasBackbone = backbone.some((v) => v !== null && v !== undefined && v !== '');
  const hasLines = Array.isArray(f.line_items) && f.line_items.length > 0;
  const hasParties = Array.isArray(f.parties) && f.parties.length > 0;
  const hasDocType = !!f.doc_type && f.doc_type !== 'other';
  return hasBackbone || hasLines || hasParties || hasDocType;
}

/** Multi-pass extraction over stored Markdown pages + the label/marking doc-type fix. */
export async function extractFromPages(pages: MarkdownPage[], fileName: string): Promise<ExtractionResult> {
  if (pages.length === 0) return { fields: null, truncated: false };
  const meta = await extractFieldsFromMarkdown(pages);
  return { fields: meta.fields ? correctLabelDocType(meta.fields, fileName) : null, truncated: meta.truncated };
}

/** One extraction row per file (UNIQUE file_id) — replace atomically. */
export async function upsertExtraction(fileId: string, workspaceId: string, fields: unknown): Promise<void> {
  await query(
    `INSERT INTO document_extractions (file_id, workspace_id, extracted_fields, model_version)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (file_id) DO UPDATE SET
       extracted_fields = EXCLUDED.extracted_fields, model_version = EXCLUDED.model_version,
       extracted_at = now()`,
    [fileId, workspaceId, JSON.stringify(fields), config.EXTRACTION_MODEL],
  );
}
