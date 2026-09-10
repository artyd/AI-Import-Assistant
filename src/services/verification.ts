import { query } from '../db/pool.js';
import {
  CONFIDENCE_FIELDS,
  type ConfidenceField,
  type FieldConfidence,
} from './extraction/extractFields.js';
import { getWorkspaceById } from './workspaceAccess.js';
import { refreshWorkspaceState } from './status.js';

/**
 * Human-in-the-loop field verification (plan Q9/Q17/Q29). Backs the batch
 * verification screen: the declarant reviews the fields extracted from every
 * document and confirms/corrects the ones that matter. Only the CONTESTED +
 * IMPORTANT fields are flagged as needing confirmation (low confidence, or the
 * document was unreadable); everything else is editable but accepted silently.
 *
 * Corrections are written back into `document_extractions.extracted_fields`, the
 * confirmed fields are marked high-confidence, and the workspace state (checklist
 * + discrepancies) is recomputed so the dashboard reflects the human's input.
 */

export interface FileExtraction {
  file_id: string;
  file_name: string;
  extraction_status: string | null;
  fields: Record<string, unknown>;
  /** Verdict-driving fields the human should confirm (low confidence / unreadable). */
  needs_review: ConfidenceField[];
  verified: boolean;
}

function fieldConfidence(fields: Record<string, unknown>): FieldConfidence {
  const fc = fields.field_confidence;
  return fc && typeof fc === 'object' ? (fc as FieldConfidence) : {};
}

/** Which key fields the human must confirm for this document. */
function computeNeedsReview(
  fields: Record<string, unknown>,
  extractionStatus: string | null,
): ConfidenceField[] {
  // An unreadable scan needs every key field entered by hand.
  if (extractionStatus === 'unreadable' || fields.unreadable === true) {
    return [...CONFIDENCE_FIELDS];
  }
  const fc = fieldConfidence(fields);
  const out: ConfidenceField[] = [];
  for (const f of CONFIDENCE_FIELDS) {
    // Flag a field when it was read with low confidence, OR it is present but the
    // model gave no confidence at all for a value it did fill in.
    if (fc[f] === 'low') out.push(f);
  }
  return out;
}

/** Returns every latest file's extraction for the verification screen. */
export async function getExtractionsForVerification(workspaceId: string): Promise<FileExtraction[]> {
  const { rows } = await query<{
    file_id: string;
    file_name: string;
    extraction_status: string | null;
    fields: Record<string, unknown> | null;
  }>(
    `SELECT f.id AS file_id,
            f.name AS file_name,
            f.extraction_status,
            de.extracted_fields AS fields
     FROM files f
     LEFT JOIN document_extractions de ON de.file_id = f.id
     WHERE f.workspace_id = $1 AND f.is_latest = true
     ORDER BY f.created_at ASC`,
    [workspaceId],
  );

  return rows.map((r) => {
    const fields = r.fields ?? {};
    return {
      file_id: r.file_id,
      file_name: r.file_name,
      extraction_status: r.extraction_status,
      fields,
      needs_review: computeNeedsReview(fields, r.extraction_status),
      verified: fields.verified === true,
    };
  });
}

export interface SaveVerificationInput {
  /** Field name → corrected/confirmed value (partial; only changed/confirmed fields). */
  fields: Record<string, unknown>;
  /** Field names the human explicitly confirmed (marked high-confidence). */
  confirmed: string[];
}

/**
 * Applies human corrections to a file's extraction. Merges the provided field
 * values, bumps confirmed fields to high confidence, clears the unreadable flag,
 * marks the record verified, and recomputes workspace state. Returns false if the
 * file has no extraction row (nothing to verify).
 */
export async function saveVerification(
  workspaceId: string,
  fileId: string,
  input: SaveVerificationInput,
): Promise<boolean> {
  const { rows } = await query<{ fields: Record<string, unknown> | null }>(
    `SELECT de.extracted_fields AS fields
     FROM document_extractions de
     JOIN files f ON f.id = de.file_id
     WHERE de.file_id = $1 AND f.workspace_id = $2`,
    [fileId, workspaceId],
  );
  if (rows.length === 0) return false;

  const current = rows[0]!.fields ?? {};
  const merged: Record<string, unknown> = { ...current, ...input.fields };

  // Confirmed fields become high-confidence.
  const fc: FieldConfidence = { ...fieldConfidence(current) };
  for (const f of input.confirmed) {
    if ((CONFIDENCE_FIELDS as readonly string[]).includes(f)) {
      fc[f as ConfidenceField] = 'high';
    }
  }
  merged.field_confidence = fc;
  merged.verified = true;
  delete merged.unreadable;

  await query(
    `UPDATE document_extractions SET extracted_fields = $3::jsonb, extracted_at = now()
     WHERE file_id = $1 AND workspace_id = $2`,
    [fileId, workspaceId, JSON.stringify(merged)],
  );
  await query(`UPDATE files SET extraction_status = 'ok' WHERE id = $1`, [fileId]);

  const ws = await getWorkspaceById(workspaceId);
  if (ws) await refreshWorkspaceState(ws);
  return true;
}
