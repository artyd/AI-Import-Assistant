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
  // Both certificate doc_types route into the merged certificates folder.
  certificate_of_origin: '03_Certificates',
  quality_certificate: '03_Certificates',
  customs_declaration: '04_Customs',
  transport: '05_Transport',
};

export type Confidence = 'high' | 'medium' | 'low';

export interface ClassifyResult {
  fileId: string;
  name: string;
  from: string | null;
  to: string | null; // null = left in inbox (unclassified or low-confidence suggestion)
  reason: string | null; // human-readable "why this folder"
  confidence: Confidence | null;
  suggested: string | null; // suggested folder when left in inbox for manual confirm
}

interface DocTypeResolution {
  docType: string | null;
  method: 'extraction' | 'image' | 'filename' | 'llm' | null;
  confidence: Confidence | null;
}

interface FileRow {
  id: string;
  name: string;
  type: FileType;
  folder_id: string | null;
  folder_name: string | null;
  disk_path: string;
}

// Filename keyword heuristic (EN/UA/RU). Ordered most-distinctive first so the
// cross-folder types (transport/customs/origin/quality/PO) win over the generic
// 01-bucket types (invoice/packing/contract all map to the same folder anyway).
// This is deterministic and free, classifies scans that have no text layer, and
// avoids an LLM call for the many clearly-named customs documents.
const FILENAME_RULES: { type: string; patterns: string[] }[] = [
  { type: 'transport', patterns: ['cmr', 'awb', 'hawb', 'mawb', 'airway', 'air way', 'waybill', 'bill of lading', 'b/l', 'consignee', 'коносамент'] },
  { type: 'customs_declaration', patterns: ['customs', 'declaration', 'декларац', 'митн', 'таможен'] },
  { type: 'certificate_of_origin', patterns: ['certificate of origin', 'coo', 'походженн', 'происхожден', 'form a', 'eur.1', 'eur1'] },
  { type: 'quality_certificate', patterns: ['coa', 'certificate of analysis', 'analysis', 'аналіз', 'анализ', 'msds', 'sds', 'quality', 'якост', 'качеств'] },
  { type: 'purchase_order', patterns: ['purchase order', 'order', 'po', 'замовленн', 'заказ'] },
  { type: 'invoice', patterns: ['invoice', 'inv', 'рахуно', 'счет', 'счёт', 'facture', 'факт'] },
  { type: 'packing_list', patterns: ['packing', 'plist', 'pack list', 'специфікац', 'пакувальн', 'упаковочн', 'pl'] },
  { type: 'contract', patterns: ['contract', 'контракт', 'договір', 'договор', 'agreement', 'угода'] },
];

// Short/ambiguous Latin tokens must match as whole words so they don't fire
// inside a longer word (e.g. 'po' in 'report', 'pl' in 'sample'). Everything
// else (Cyrillic stems, full English words) matches as a substring so inflected
// forms are caught (рахуно→рахунок, декларац→декларація, походженн→походження).
const BOUNDARY_TOKENS = new Set([
  'po', 'pl', 'inv', 'coo', 'coa', 'sds', 'msds', 'awb', 'cmr', 'hawb', 'mawb',
  'order', 'eur1', 'eur 1', 'b l', 'form a', 'air way',
]);

/** Normalize to lowercase with every non-alphanumeric run collapsed to a single
 *  space, padded so whole-word checks work (handles ._-/()[] and Cyrillic). */
function normalizeName(s: string): string {
  return ` ${s.toLowerCase().replace(/[^0-9a-zа-яёіїєґ]+/gi, ' ').trim()} `;
}

function classifyByFilename(name: string): string | null {
  const n = normalizeName(name);
  for (const rule of FILENAME_RULES) {
    for (const p of rule.patterns) {
      const core = normalizeName(p).trim();
      const hit = BOUNDARY_TOKENS.has(core) ? n.includes(` ${core} `) : n.includes(core);
      if (hit) return rule.type;
    }
  }
  return null;
}

async function resolveDocType(file: FileRow): Promise<DocTypeResolution> {
  // 1. Prefer an existing structured extraction (deterministic, no LLM cost).
  //    Treat 'other' as inconclusive and keep going. Highest confidence.
  const { rows } = await query<{ doc_type: string | null }>(
    `SELECT extracted_fields->>'doc_type' AS doc_type
     FROM document_extractions WHERE file_id = $1 ORDER BY extracted_at DESC LIMIT 1`,
    [file.id],
  );
  const stored = rows[0]?.doc_type;
  if (stored && stored !== 'other') {
    return { docType: stored, method: 'extraction', confidence: 'high' };
  }

  // 2. Images have no text layer → photos.
  if (file.type === 'image') return { docType: 'photos', method: 'image', confidence: 'high' };

  // 3. Filename heuristic — cheap, language-aware, works on scans. Medium.
  const byName = classifyByFilename(file.name);
  if (byName) return { docType: byName, method: 'filename', confidence: 'medium' };

  // 4. Fall back to the text-based classifier, but skip the LLM entirely when
  //    there's no meaningful text (e.g. a scanned PDF with no text layer) —
  //    that both avoids a wasted/erroring call and keeps large batches fast.
  //    LLM-on-content is the fuzziest signal → LOW confidence (kept in inbox for
  //    manual confirmation rather than auto-moved).
  let text = '';
  try {
    const buf = await readStoredFile(file.disk_path);
    const pages = await extractText(buf, file.type);
    text = pages.map((p) => p.text).join('\n\n').trim();
  } catch {
    return { docType: null, method: null, confidence: null };
  }
  if (text.length < 20) return { docType: null, method: null, confidence: null };
  const fields = await extractDocumentFields(text);
  const docType = fields?.doc_type;
  return docType && docType !== 'other'
    ? { docType, method: 'llm', confidence: 'low' }
    : { docType: null, method: null, confidence: null };
}

function reasonText(method: DocTypeResolution['method'], docType: string, folder: string): string {
  switch (method) {
    case 'extraction':
      return `структурне витягнення визначило тип «${docType}» → ${folder}`;
    case 'image':
      return `файл є зображенням → ${folder}`;
    case 'filename':
      return `назва файлу вказує на «${docType}» → ${folder}`;
    case 'llm':
      return `ІІ визначив за вмістом тип «${docType}» → ${folder}`;
    default:
      return `тип «${docType}» → ${folder}`;
  }
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

  const empty: ClassifyResult = {
    fileId: file.id,
    name: file.name,
    from: file.folder_name,
    to: null,
    reason: null,
    confidence: null,
    suggested: null,
  };

  const { docType, method, confidence } = await resolveDocType(file);
  const targetName =
    docType === 'photos' ? '06_Photos' : docType ? DOC_TYPE_TO_FOLDER[docType] : undefined;
  if (!targetName || !docType) return empty;

  const { rows: folders } = await query<{ id: string }>(
    'SELECT id FROM folders WHERE workspace_id = $1 AND name = $2 LIMIT 1',
    [workspaceId, targetName],
  );
  const target = folders[0];
  if (!target) {
    // Skeleton folder missing (custom layout) — leave in inbox rather than guess.
    return empty;
  }

  const reason = reasonText(method, docType, targetName);

  // Low confidence → do NOT auto-move. Keep in the inbox with a suggested folder
  // and the reason, so the user confirms it manually.
  if (confidence === 'low') {
    await query(
      `UPDATE files SET suggested_folder_id = $1, folder_reason = $2, folder_confidence = 'low'
       WHERE id = $3 AND workspace_id = $4`,
      [target.id, reason, file.id, workspaceId],
    );
    return {
      fileId: file.id,
      name: file.name,
      from: file.folder_name,
      to: null,
      reason,
      confidence: 'low',
      suggested: targetName,
    };
  }

  // High/medium → move. Never deletes or overwrites. Record why + how confident.
  await query(
    `UPDATE files SET folder_id = $1, suggested_folder_id = NULL,
            folder_reason = $2, folder_confidence = $3
     WHERE id = $4 AND workspace_id = $5`,
    [target.id, reason, confidence, file.id, workspaceId],
  );

  return {
    fileId: file.id,
    name: file.name,
    from: file.folder_name,
    to: targetName,
    reason,
    confidence,
    suggested: null,
  };
}

export interface SortInboxResult {
  moved: { fileId: string; name: string; to: string; reason: string | null }[];
  // Left in inbox: either a low-confidence suggestion (suggested set) or truly
  // unclassified (suggested null).
  unclassified: { fileId: string; name: string; suggested: string | null; reason: string | null }[];
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
    if (res.to) moved.push({ fileId: res.fileId, name: res.name, to: res.to, reason: res.reason });
    else unclassified.push({ fileId: res.fileId, name: res.name, suggested: res.suggested, reason: res.reason });
  }
  return { moved, unclassified };
}
