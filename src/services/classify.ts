import { query } from '../db/pool.js';
import { readStoredFile } from './storage.js';
import { extractText } from './extract/index.js';
import { extractDocumentFields } from './extraction/extractFields.js';
import type { FileType } from '../domain/folders.js';

/**
 * Inbox auto-sort. Determines a document's category and MOVES it into the
 * matching skeleton folder. It only ever updates `files.folder_id` — never
 * deletes or overwrites — so a wrong guess is corrected by a normal follow-up
 * move, no special undo needed.
 *
 * Category comes from the existing structured extraction when available
 * (deterministic, free); otherwise a constrained forced-tool LLM classification
 * (`extractDocumentFields` — same classifier used at index time).
 */

const DOC_TYPE_TO_FOLDER: Record<string, string> = {
  contract: '01_Contract_Invoice_PackingList',
  invoice: '01_Contract_Invoice_PackingList',
  packing_list: '01_Contract_Invoice_PackingList',
  purchase_order: '02_PO',
  certificate_of_origin: '03_Certificate_of_Origin',
  quality_certificate: '04_Quality_Certificates',
  customs_declaration: '05_Customs',
  transport: '06_Transport',
};

export interface ClassifyResult {
  fileId: string;
  name: string;
  from: string | null;
  to: string | null; // null = left in inbox (unclassified)
}

interface FileRow {
  id: string;
  name: string;
  type: FileType;
  folder_id: string | null;
  folder_name: string | null;
  disk_path: string;
}

async function resolveDocType(file: FileRow): Promise<string | null> {
  // Prefer an existing extraction (deterministic, no LLM cost).
  const { rows } = await query<{ doc_type: string | null }>(
    `SELECT extracted_fields->>'doc_type' AS doc_type
     FROM document_extractions WHERE file_id = $1 ORDER BY extracted_at DESC LIMIT 1`,
    [file.id],
  );
  if (rows[0]?.doc_type) return rows[0].doc_type;

  // Images have no text layer → photos.
  if (file.type === 'image') return 'photos';

  // Fallback: classify from text via the constrained extractor.
  const buf = await readStoredFile(file.disk_path);
  const pages = await extractText(buf, file.type);
  if (pages.length === 0) return null;
  const fields = await extractDocumentFields(pages.map((p) => p.text).join('\n\n'));
  return fields?.doc_type ?? null;
}

/** Classifies one file and moves it into the matching folder (move-only). */
export async function classifyAndFile(
  workspaceId: string,
  fileId: string,
): Promise<ClassifyResult | null> {
  const { rows } = await query<FileRow>(
    `SELECT f.id, f.name, f.type, f.folder_id, f.disk_path, fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.id = $1 AND f.workspace_id = $2`,
    [fileId, workspaceId],
  );
  const file = rows[0];
  if (!file) return null;

  const docType = await resolveDocType(file);
  const targetName =
    docType === 'photos' ? '07_Photos' : docType ? DOC_TYPE_TO_FOLDER[docType] : undefined;
  if (!targetName) {
    return { fileId: file.id, name: file.name, from: file.folder_name, to: null };
  }

  const { rows: folders } = await query<{ id: string }>(
    'SELECT id FROM folders WHERE workspace_id = $1 AND name = $2 LIMIT 1',
    [workspaceId, targetName],
  );
  const target = folders[0];
  if (!target) {
    // Skeleton folder missing (custom layout) — leave in inbox rather than guess.
    return { fileId: file.id, name: file.name, from: file.folder_name, to: null };
  }

  // Move only. Never deletes or overwrites.
  await query('UPDATE files SET folder_id = $1 WHERE id = $2 AND workspace_id = $3', [
    target.id,
    file.id,
    workspaceId,
  ]);

  return { fileId: file.id, name: file.name, from: file.folder_name, to: targetName };
}

export interface SortInboxResult {
  moved: { fileId: string; name: string; to: string }[];
  unclassified: { fileId: string; name: string }[];
}

/** Classifies and files every inbox (folder_id IS NULL) file. */
export async function sortInbox(workspaceId: string): Promise<SortInboxResult> {
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM files WHERE workspace_id = $1 AND folder_id IS NULL ORDER BY created_at',
    [workspaceId],
  );

  const moved: SortInboxResult['moved'] = [];
  const unclassified: SortInboxResult['unclassified'] = [];
  for (const { id } of rows) {
    const res = await classifyAndFile(workspaceId, id);
    if (!res) continue;
    if (res.to) moved.push({ fileId: res.fileId, name: res.name, to: res.to });
    else unclassified.push({ fileId: res.fileId, name: res.name });
  }
  return { moved, unclassified };
}
