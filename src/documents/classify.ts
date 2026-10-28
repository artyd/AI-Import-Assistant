import { query } from '../db/pool.js';
import { readStoredFile } from '../lib/storage.js';
import { extractText } from '../ingest/extract/index.js';
import { loadFileMarkdown } from '../ingest/markdown/store.js';
import { classifyDocTypeCheap } from '../ingest/extraction/extractFields.js';
import { fclFolderRole, type FileType } from '../shipments/folders.js';
import { assignLot } from '../shipments/lotAssign.js';
import {
  ensureLot,
  fclFolderId,
  getLot,
  loadLotProfiles,
  lotCustomsFolderId,
  lotFolderId,
  productFolderId,
  setFileLinks,
} from '../shipments/lots.js';
import { createsProducts, docProducts, placeInLot } from '../shipments/fclLayout.js';
import { folderPath } from '../shipments/folderPath.js';
import { publishFileStatus, type FileStatusEvent } from '../lib/events/fileStatus.js';
import { logIngest, q } from '../ingest/journal.js';

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

export const DOC_TYPE_TO_FOLDER: Record<string, string> = {
  contract: '01_Contract_Invoice_PackingList',
  invoice: '01_Contract_Invoice_PackingList',
  packing_list: '01_Contract_Invoice_PackingList',
  // Both certificate doc_types route into the merged certificates folder.
  certificate_of_origin: '03_Certificates',
  quality_certificate: '03_Certificates',
  customs_declaration: '04_Customs',
  transport: '05_Transport',
  // Filename-only categories (never produced by the structured extraction): vet /
  // sanitary documents and permits sit with the certificates, shipping
  // instructions with the contract, labels/marking with the cargo photos.
  veterinary: '03_Certificates',
  instruction: '01_Contract_Invoice_PackingList',
  label: '06_Photos',
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
  status: FileStatusEvent['status'];
  batch_id: string | null;
}

/**
 * Tell open file trees that a file changed folder. Without it the move happened
 * in the database only and the file sat in the inbox on screen until a reload —
 * which read as "files are not sorted". Best-effort: the move itself stands.
 */
async function announceMove(workspaceId: string, file: FileRow, folderId: string, links: string[] = []): Promise<void> {
  await publishFileStatus(workspaceId, { fileId: file.id, status: file.status, name: file.name, folderId }).catch(
    () => undefined,
  );
  // The reading journal: where the file went and which product folders show it too.
  const path = (await folderPath(folderId).catch(() => [])).join(' / ');
  const also = await Promise.all(links.map((l) => folderPath(l).then((p) => p[p.length - 1] ?? '').catch(() => '')));
  const named = also.filter(Boolean);
  await logIngest(workspaceId, {
    fileId: file.id,
    batchId: file.batch_id,
    kind: 'file',
    text: `Кладу ${q(file.name)} → ${path}${named.length ? ` (і посилання в папках товарів: ${named.join(', ')})` : ''}.`,
  });
}

/** Journal line for a file left in the inbox. */
async function announceInbox(workspaceId: string, file: FileRow, reason: string | null, suggested: string | null): Promise<void> {
  await logIngest(workspaceId, {
    fileId: file.id,
    batchId: file.batch_id,
    kind: 'warn',
    text:
      `Не впевнений, куди покласти ${q(file.name)}${reason ? ` (${reason})` : ''} — лишаю в Інбоксі` +
      `${suggested ? `, ймовірно: ${suggested}` : ''}.`,
  });
}

// Filename keyword heuristic (EN/UA/RU). Ordered most-distinctive first so the
// cross-folder types (transport/customs/origin/quality/PO) win over the generic
// 01-bucket types (invoice/packing/contract all map to the same folder anyway).
// This is deterministic and free, classifies scans that have no text layer, and
// avoids an LLM call for the many clearly-named customs documents.
const FILENAME_RULES: { type: string; patterns: string[] }[] = [
  // Vet-specific first: "CHEDP.PL.2026…" must not fall through to the 'pl'
  // packing-list token, nor "BSE_Declaration" to customs.
  { type: 'veterinary', patterns: ['ched', 'chedp', 'health certificate', 'veterinar', 'ветерин', 'ветсерт', 'bse', 'deklaracja', 'rozdzia'] },
  { type: 'instruction', patterns: ['инструкц', 'інструкц', 'instruction'] },
  { type: 'transport', patterns: ['cmr', 'awb', 'hawb', 'mawb', 'airway', 'air way', 'waybill', 'bill of lading', 'b/l', 'consignee', 'коносамент'] },
  { type: 'customs_declaration', patterns: ['customs', 'declaration', 'декларац', 'митн', 'таможен'] },
  { type: 'certificate_of_origin', patterns: ['certificate of origin', 'coo', 'походженн', 'происхожден', 'form a', 'eur.1', 'eur1'] },
  { type: 'quality_certificate', patterns: ['coa', 'certificate of analysis', 'analysis', 'аналіз', 'анализ', 'msds', 'sds', 'quality', 'якост', 'качеств'] },
  { type: 'invoice', patterns: ['invoice', 'inv', 'рахуно', 'счет', 'счёт', 'facture', 'факт'] },
  { type: 'packing_list', patterns: ['packing', 'plist', 'pack list', 'специфікац', 'пакувальн', 'упаковочн', 'pl'] },
  { type: 'contract', patterns: ['contract', 'контракт', 'договір', 'договор', 'agreement', 'угода'] },
  // Generic words last, so a customs/transport/contract name wins over them.
  { type: 'label', patterns: ['label', 'маркировк', 'маркуванн', 'этикет', 'етикет'] },
  { type: 'veterinary', patterns: ['statement', 'реєстраційне посвідчення', 'posvidchen', 'регистрац', 'registration certificate'] },
];

/** Categories only the filename rules produce (the structured extraction can't). */
const FILENAME_ONLY_TYPES = new Set(['veterinary', 'instruction', 'label']);

// Short/ambiguous Latin tokens must match as whole words so they don't fire
// inside a longer word (e.g. 'po' in 'report', 'pl' in 'sample'). Everything
// else (Cyrillic stems, full English words) matches as a substring so inflected
// forms are caught (рахуно→рахунок, декларац→декларація, походженн→походження).
const BOUNDARY_TOKENS = new Set([
  'po', 'pl', 'inv', 'coo', 'coa', 'sds', 'msds', 'awb', 'cmr', 'hawb', 'mawb',
  'order', 'eur1', 'eur 1', 'b l', 'form a', 'air way', 'ched', 'chedp', 'bse',
]);

/** Normalize to lowercase with every non-alphanumeric run collapsed to a single
 *  space, padded so whole-word checks work (handles ._-/()[] and Cyrillic). */
function normalizeName(s: string): string {
  return ` ${s.toLowerCase().replace(/[^0-9a-zа-яёіїєґ]+/gi, ' ').trim()} `;
}

export function classifyByFilename(name: string): string | null {
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
  // The full extraction already looked at this document and said 'other' — a
  // second LLM pass over the same text won't do better (it used to re-run the
  // whole Opus extraction). Filename heuristics below still apply.
  const alreadyExtracted = rows.length > 0;

  // 2. Images have no text layer → photos.
  if (file.type === 'image') return { docType: 'photos', method: 'image', confidence: 'high' };

  // 3. Filename heuristic — cheap, language-aware, works on scans. Medium.
  //    But when the full extraction already read the content and found it is
  //    none of the shipment document types, a filename hit ("PL_Eprinil…" — a
  //    leaflet, not a packing list) is only a hint: LOW → stays in the inbox
  //    with a suggestion instead of being filed into the customs package.
  const byName = classifyByFilename(file.name);
  if (byName) {
    // The extraction's 'other' only contradicts a filename hit for the shipment
    // doc types it knows; the filename-only categories are 'other' to it by design.
    const filenameOnly = FILENAME_ONLY_TYPES.has(byName);
    return { docType: byName, method: 'filename', confidence: alreadyExtracted && !filenameOnly ? 'low' : 'medium' };
  }

  // 4. Fall back to the text-based classifier, but skip the LLM entirely when
  //    there's no meaningful text (e.g. a scanned PDF with no text layer) —
  //    that both avoids a wasted/erroring call and keeps large batches fast.
  //    LLM-on-content is the fuzziest signal → LOW confidence (kept in inbox for
  //    manual confirmation rather than auto-moved).
  let text = '';
  try {
    // Prefer the ingest-time Markdown (Claude's transcription — covers scans);
    // fall back to raw text extraction for files not yet converted.
    const stored = await loadFileMarkdown(file.id);
    if (stored) {
      text = stored.pages.map((p) => p.markdown).join('\n\n').trim();
    } else {
      const buf = await readStoredFile(file.disk_path);
      const pages = await extractText(buf, file.type);
      text = pages.map((p) => p.text).join('\n\n').trim();
    }
  } catch {
    return { docType: null, method: null, confidence: null };
  }
  if (text.length < 20 || alreadyExtracted) return { docType: null, method: null, confidence: null };
  const docType = await classifyDocTypeCheap(text).catch(() => null);
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

/**
 * Classifies one file. With `move: true` (default) it moves the file into the
 * matching skeleton folder (move-only, high/medium confidence). With
 * `move: false` it NEVER moves — it only records the detected type as a
 * suggestion (`suggested_folder_id` + reason + confidence), leaving placement to
 * the human or to export-time assembly (plan Q14/Q16: no silent auto-move).
 */
export async function classifyAndFile(
  workspaceId: string,
  fileId: string,
  opts: { move?: boolean } = {},
): Promise<ClassifyResult | null> {
  const move = opts.move !== false;
  const { rows } = await query<FileRow>(
    `SELECT f.id, f.name, f.type, f.folder_id, f.disk_path, f.status, f.batch_id, fo.name AS folder_name
     FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.id = $1 AND f.workspace_id = $2`,
    [fileId, workspaceId],
  );
  const file = rows[0];
  if (!file) return null;

  if (await isFclWorkspace(workspaceId)) return classifyIntoFcl(workspaceId, file, move);

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

  // Suggestion-only mode (plan Q14/Q16): record the detected type as a suggested
  // folder + reason, never move. The single-list UI shows the label; the actual
  // folder structure is assembled at export time.
  if (!move) {
    await query(
      `UPDATE files SET suggested_folder_id = $1, folder_reason = $2, folder_confidence = $3
       WHERE id = $4 AND workspace_id = $5`,
      [target.id, reason, confidence, file.id, workspaceId],
    );
    return {
      fileId: file.id,
      name: file.name,
      from: file.folder_name,
      to: null,
      reason,
      confidence,
      suggested: targetName,
    };
  }

  // Low confidence → do NOT auto-move. Keep in the inbox with a suggested folder
  // and the reason, so the user confirms it manually.
  if (confidence === 'low') {
    await query(
      `UPDATE files SET suggested_folder_id = $1, folder_reason = $2, folder_confidence = 'low'
       WHERE id = $3 AND workspace_id = $4`,
      [target.id, reason, file.id, workspaceId],
    );
    await announceInbox(workspaceId, file, reason, targetName);
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
  // Only if the file is still where we found it: the classification can take an
  // LLM call, and a manual move made meanwhile must win.
  const moved = await query(
    `UPDATE files SET folder_id = $1, suggested_folder_id = NULL,
            folder_reason = $2, folder_confidence = $3
     WHERE id = $4 AND workspace_id = $5 AND folder_id IS NOT DISTINCT FROM $6`,
    [target.id, reason, confidence, file.id, workspaceId, file.folder_id],
  );
  if ((moved.rowCount ?? 0) === 0) return empty;
  await announceMove(workspaceId, file, target.id);

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

async function isFclWorkspace(workspaceId: string): Promise<boolean> {
  const { rows } = await query<{ kind: string }>('SELECT kind FROM workspaces WHERE id = $1', [workspaceId]);
  return rows[0]?.kind === 'fcl';
}

/**
 * FCL (Збірник) filing: the document goes to its lot's folder, or to an FCL folder
 * (manifest / transport / customs), by `assignLot` — a new supplier on an invoice,
 * contract or packing list opens a new lot. Anything ambiguous stays in the inbox
 * with the likely lot as a suggestion.
 */
async function classifyIntoFcl(workspaceId: string, file: FileRow, move: boolean): Promise<ClassifyResult> {
  const base = { fileId: file.id, name: file.name, from: file.folder_name };
  const { rows } = await query<{ fields: Record<string, unknown> }>(
    'SELECT extracted_fields AS fields FROM document_extractions WHERE file_id = $1 ORDER BY extracted_at DESC LIMIT 1',
    [file.id],
  );
  let fields: Record<string, unknown> | null = rows[0]?.fields ?? null;
  let confidence: Confidence = 'high';
  if (!fields || !fields.doc_type || fields.doc_type === 'other') {
    // No usable extraction: the filename/LLM type alone can still place FCL papers.
    const { docType, confidence: c } = await resolveDocType(file);
    if (docType && docType !== 'photos') {
      fields = { ...(fields ?? {}), doc_type: docType };
      confidence = c ?? 'low';
    }
  }

  const assignment = assignLot({ file_name: file.name, file_type: file.type, fields }, await loadLotProfiles(workspaceId));
  const docType = typeof fields?.doc_type === 'string' ? fields.doc_type : null;

  let targetId: string | null = null;
  let links: string[] = [];
  if (assignment.kind === 'fcl') {
    targetId = await fclFolderId(workspaceId, assignment.folder);
  } else if (assignment.kind === 'lot' || assignment.kind === 'new') {
    if (assignment.kind === 'lot' && assignment.confidence === 'medium' && confidence === 'high') confidence = 'medium';
    const sure = move && confidence !== 'low';
    const lot =
      assignment.kind === 'lot'
        ? await getLot(workspaceId, assignment.lotId)
        : sure
          ? (await ensureLot(workspaceId, assignment.supplierName, 'auto')).lot
          : null;
    if (lot) ({ targetId, links } = await placeWithinLot(workspaceId, lot, docType, fields, sure));
  } else if (assignment.suggestLotId) {
    targetId = await lotFolderId(assignment.suggestLotId);
    confidence = 'low';
  } else {
    await query(
      `UPDATE files SET suggested_folder_id = NULL, folder_reason = $1, folder_confidence = NULL
       WHERE id = $2 AND workspace_id = $3`,
      [assignment.reason, file.id, workspaceId],
    );
    if (move) await announceInbox(workspaceId, file, assignment.reason, null);
    return { ...base, to: null, reason: assignment.reason, confidence: null, suggested: null };
  }
  const targetName = targetId ? (await folderPath(targetId)).join(' / ') || null : null;
  if (!targetId || !targetName) {
    if (move) await announceInbox(workspaceId, file, assignment.reason, null);
    return { ...base, to: null, reason: assignment.reason, confidence: null, suggested: null };
  }

  if (targetId === file.folder_id) {
    await setFileLinks(file.id, links.filter((l) => l !== targetId));
    return { ...base, to: targetName, reason: assignment.reason, confidence, suggested: null };
  }
  if (!move || confidence === 'low' || assignment.kind === 'inbox') {
    await query(
      `UPDATE files SET suggested_folder_id = $1, folder_reason = $2, folder_confidence = $3
       WHERE id = $4 AND workspace_id = $5`,
      [targetId, assignment.reason, confidence, file.id, workspaceId],
    );
    if (move) await announceInbox(workspaceId, file, assignment.reason, targetName);
    return { ...base, to: null, reason: assignment.reason, confidence, suggested: targetName };
  }

  const moved = await query(
    `UPDATE files SET folder_id = $1, suggested_folder_id = NULL, folder_reason = $2, folder_confidence = $3
     WHERE id = $4 AND workspace_id = $5 AND folder_id IS NOT DISTINCT FROM $6`,
    [targetId, assignment.reason, confidence, file.id, workspaceId, file.folder_id],
  );
  if ((moved.rowCount ?? 0) === 0) return { ...base, to: null, reason: null, confidence: null, suggested: null };
  const extra = links.filter((l) => l !== targetId);
  await setFileLinks(file.id, extra);
  await announceMove(workspaceId, file, targetId, extra);
  return { ...base, to: targetName, reason: assignment.reason, confidence, suggested: null };
}

/**
 * The folder inside a lot (spec 007): customs papers → «Митниця / <постачальник>»,
 * product papers → «<постачальник> / <товар>» (the lot root when the product is
 * unknown). The product folders the document names become its links. Only the
 * anchor documents create product folders, and only when the filing is certain.
 */
async function placeWithinLot(
  workspaceId: string,
  lot: { id: string; name: string },
  docType: string | null,
  fields: Record<string, unknown> | null,
  sure: boolean,
): Promise<{ targetId: string | null; links: string[] }> {
  const create = sure && createsProducts(docType);
  const productIds: string[] = [];
  for (const p of docProducts(fields)) {
    const id = await productFolderId(workspaceId, lot.id, p, create);
    if (id && !productIds.includes(id)) productIds.push(id);
  }
  if (placeInLot(docType) === 'lot_customs') {
    return { targetId: await lotCustomsFolderId(workspaceId, lot), links: productIds };
  }
  return { targetId: productIds[0] ?? (await lotFolderId(lot.id)), links: productIds.slice(1) };
}

/**
 * Whether a file should be (re-)filed automatically: an inbox file, or — in an
 * FCL — a file in a folder that is neither a lot nor an FCL folder (the type
 * folders of collections made before spec 006), or one lying in a lot's root
 * folder (the flat lots before spec 007), so it reaches «Митниця» / its product.
 */
export async function needsAutoFiling(fileId: string): Promise<boolean> {
  const { rows } = await query<{
    folder_id: string | null;
    folder_name: string | null;
    lot_id: string | null;
    parent_id: string | null;
    role: string | null;
    kind: string;
  }>(
    `SELECT f.folder_id, fo.name AS folder_name, fo.lot_id, fo.parent_id, fo.role, w.kind
     FROM files f JOIN workspaces w ON w.id = f.workspace_id
     LEFT JOIN folders fo ON fo.id = f.folder_id
     WHERE f.id = $1`,
    [fileId],
  );
  const r = rows[0];
  if (!r) return false;
  if (r.folder_id === null) return true;
  if (r.kind !== 'fcl') return false;
  if (r.lot_id !== null) return r.role === 'lot';
  return r.parent_id === null && fclFolderRole(r.folder_name ?? '') === null;
}

/**
 * True while the file's upload batch is still being read. An FCL files a batch
 * only once all of it is read (spec 007): the invoices then open the suppliers
 * and products before the certificates look for them.
 */
export async function batchStillReading(batchId: string | null): Promise<boolean> {
  if (!batchId) return false;
  const { rows } = await query<{ reconcile_done: boolean }>('SELECT reconcile_done FROM ingest_batches WHERE id = $1', [batchId]);
  return rows[0] ? !rows[0].reconcile_done : false;
}

const ANCHOR_FIRST = ['invoice', 'contract', 'packing_list'];

/**
 * Files a fully read FCL batch: the anchor documents first (they create the lots
 * and the product folders), then everything else. Returns how many were filed.
 */
export async function fileFclBatch(workspaceId: string, batchId: string): Promise<{ filed: number; inbox: number }> {
  const { rows } = await query<{ id: string; doc_type: string | null }>(
    `SELECT f.id, de.extracted_fields->>'doc_type' AS doc_type
     FROM files f LEFT JOIN document_extractions de ON de.file_id = f.id
     WHERE f.workspace_id = $1 AND f.batch_id = $2 AND f.is_latest = true
     ORDER BY f.created_at, f.name`,
    [workspaceId, batchId],
  );
  const rank = (t: string | null): number => {
    const i = ANCHOR_FIRST.indexOf(t ?? '');
    return i === -1 ? ANCHOR_FIRST.length : i;
  };
  const ordered = [...rows].sort((a, b) => rank(a.doc_type) - rank(b.doc_type));
  let filed = 0;
  let inbox = 0;
  for (const { id } of ordered) {
    if (!(await needsAutoFiling(id))) continue;
    const res = await classifyAndFile(workspaceId, id, { move: true });
    if (res?.to) filed++;
    else inbox++;
  }
  // A second pass for papers whose lot / product appeared later in this batch.
  if (inbox > 0) {
    const again = await refileFclInbox(workspaceId);
    filed += again;
    inbox -= Math.min(inbox, again);
  }
  return { filed, inbox };
}

/**
 * FCL: files read earlier than the lot they belong to (a CoA processed before its
 * supplier's invoice opened the lot) stay in the inbox. Re-run the assignment for
 * inbox files that already have an extraction — no LLM call, only lookups.
 */
export async function refileFclInbox(workspaceId: string): Promise<number> {
  const { rows } = await query<{ id: string }>(
    `SELECT f.id FROM files f
     JOIN document_extractions de ON de.file_id = f.id
     LEFT JOIN ingest_batches b ON b.id = f.batch_id
     WHERE f.workspace_id = $1 AND f.folder_id IS NULL AND f.is_latest = true
       -- a batch still being read is filed as a whole when it is done
       AND (b.id IS NULL OR b.reconcile_done = true)
       -- 'other' papers (labels, vet certificates…) count when they name the goods.
       AND (COALESCE(de.extracted_fields->>'doc_type', 'other') <> 'other'
            OR de.extracted_fields->>'product_name' IS NOT NULL
            OR de.extracted_fields->>'cas_number' IS NOT NULL
            OR de.extracted_fields->>'batch_number' IS NOT NULL)
     ORDER BY f.created_at`,
    [workspaceId],
  );
  let moved = 0;
  for (const { id } of rows) {
    const res = await classifyAndFile(workspaceId, id, { move: true });
    if (res?.to) moved++;
  }
  return moved;
}

export interface SortInboxResult {
  moved: { fileId: string; name: string; to: string; reason: string | null }[];
  // Left in inbox: either a low-confidence suggestion (suggested set) or truly
  // unclassified (suggested null).
  unclassified: { fileId: string; name: string; suggested: string | null; reason: string | null }[];
}

/** Classifies and files every inbox (folder_id IS NULL) file. */
export async function sortInbox(workspaceId: string): Promise<SortInboxResult> {
  // An FCL also re-sorts files left in pre-spec-006 type folders (needsAutoFiling).
  const fcl = await isFclWorkspace(workspaceId);
  const { rows: all } = await query<{ id: string; folder_id: string | null; doc_type: string | null }>(
    `SELECT f.id, f.folder_id, de.extracted_fields->>'doc_type' AS doc_type
     FROM files f LEFT JOIN document_extractions de ON de.file_id = f.id
     WHERE f.workspace_id = $1 ${fcl ? 'AND f.is_latest = true' : 'AND f.folder_id IS NULL'}
     ORDER BY f.created_at`,
    [workspaceId],
  );
  // An FCL files its anchors first: invoices / contracts / packing lists open the
  // suppliers and product folders the certificates are then filed into.
  const rank = (t: string | null): number => (fcl && ANCHOR_FIRST.includes(t ?? '') ? 0 : 1);
  const rows = [];
  for (const r of [...all].sort((a, b) => rank(a.doc_type) - rank(b.doc_type))) {
    if (r.folder_id === null || (await needsAutoFiling(r.id))) rows.push(r);
  }

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
