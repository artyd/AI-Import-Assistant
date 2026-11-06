import { query } from '../db/pool.js';
import { publishFileStatus } from '../lib/events/fileStatus.js';
import { deleteStoredFile } from '../lib/storage.js';

export const SUPERSEDED_KEEP_DAYS = 7;

/**
 * A corrected re-upload replaces the old file. Users fix a document with errors
 * and upload it again under any name («PL_123_fixed.pdf», «PL 123 (1).pdf»): both
 * stayed «current», the reconciler kept checking the OLD one and the agent mixed
 * them up. After a file is read, an earlier current file that is the SAME document
 * (same type + same number + same seller) is deleted and the new one takes its
 * place: the old one is hidden (is_latest=false, superseded_at) and deleted by the
 * sweep after SUPERSEDED_KEEP_DAYS — until then «Це не нова версія» restores it
 * (undoReplace). The user wanted the old file gone (2026-11-06); the grace
 * period exists only so a wrong match can be undone.
 *
 * Deliberately strict — deleting the wrong file is worse than a duplicate:
 * - only invoices, packing lists, contracts and transport documents (they carry
 *   a document number); certificates and declarations are never matched;
 * - invoices / packing lists / contracts also need the same seller: in a
 *   trilateral deal both legs often share the invoice number but not the seller.
 */

export interface DocIdentity {
  doc_type?: string | null;
  invoice_number?: string | null;
  contract_number?: string | null;
  transport_doc_number?: string | null;
  transport_doc_kind?: string | null;
  seller?: string | null;
}

/** «INV-2024/015» = «inv 2024 015»; numbers shorter than 3 characters are too weak to match on. */
export function normalizeNumber(v: string | null | undefined): string | null {
  const n = (v ?? '').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  return n.length >= 3 ? n : null;
}

const LEGAL_FORMS = new Set([
  'CO', 'COMPANY', 'LTD', 'LIMITED', 'LLC', 'INC', 'CORP', 'CORPORATION', 'GMBH', 'AG', 'SA', 'SAS', 'SRL', 'SPA', 'BV', 'PLC',
  'SP', 'Z', 'O', 'OO', 'ТОВ', 'ТЗОВ', 'ПП', 'ФОП', 'ООО', 'АТ', 'ПАТ', 'ПРАТ',
]);

/** «Hebei Foo Co., Ltd.» = «HEBEI FOO CO LTD» = «Hebei Foo». */
export function normalizeCompany(v: string | null | undefined): string | null {
  const n = (v ?? '')
    .toUpperCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join('');
  return n.length >= 3 ? n : null;
}

function numberOf(d: DocIdentity): string | null {
  switch (d.doc_type) {
    case 'invoice':
    case 'packing_list':
      return normalizeNumber(d.invoice_number);
    case 'contract':
      return normalizeNumber(d.contract_number);
    case 'transport':
      return normalizeNumber(d.transport_doc_number);
    default:
      return null;
  }
}

/** True when `b` is a new version of the same document as `a`. */
export function isSameDocument(a: DocIdentity, b: DocIdentity): boolean {
  if (!a.doc_type || a.doc_type !== b.doc_type) return false;
  const na = numberOf(a);
  if (!na || na !== numberOf(b)) return false;
  if (a.doc_type === 'transport') {
    // A house bill and the master bill may quote each other's number.
    return !a.transport_doc_kind || !b.transport_doc_kind || a.transport_doc_kind === b.transport_doc_kind;
  }
  const sa = normalizeCompany(a.seller);
  return !!sa && sa === normalizeCompany(b.seller);
}

/**
 * Hide the earlier current files that `fileId` is a new version of. Returns the
 * names of the replaced files (empty when none). The caller runs shipmentChanged.
 */
export async function replaceEarlierVersions(workspaceId: string, fileId: string): Promise<string[]> {
  const { rows } = await query<{ id: string; name: string; disk_path: string; created_at: Date; version: number; fields: DocIdentity | null }>(
    `SELECT f.id, f.name, f.disk_path, f.created_at, f.version, de.extracted_fields AS fields
     FROM files f
     LEFT JOIN document_extractions de ON de.file_id = f.id
     WHERE f.workspace_id = $1 AND f.is_latest = true`,
    [workspaceId],
  );
  const self = rows.find((r) => r.id === fileId);
  if (!self?.fields) return [];
  // Only OLDER files: re-reading an old file (reindex) must never delete a newer one.
  const older = rows.filter(
    (r) => r.id !== fileId && r.fields && r.created_at < self.created_at && isSameDocument(r.fields, self.fields!),
  );
  if (!older.length) return [];

  const version = Math.max(...older.map((r) => r.version)) + 1;
  for (const old of older) {
    await query(
      'UPDATE files SET is_latest = false, superseded_at = now(), superseded_by = $3 WHERE id = $1 AND workspace_id = $2',
      [old.id, workspaceId, fileId],
    );
    await publishFileStatus(workspaceId, { fileId: old.id, status: 'deleted', name: old.name, replacedBy: fileId });
  }
  await query('UPDATE files SET version = $2, replaces_file_id = $3 WHERE id = $1', [fileId, version, older[0]!.id]);
  return older.map((r) => r.name);
}

/**
 * «Це не нова версія»: put back every file `fileId` auto-replaced (still within
 * the grace period). Returns the restored files, or null when there is nothing
 * to undo. The caller runs shipmentChanged.
 */
export async function undoReplace(workspaceId: string, fileId: string): Promise<{ id: string; name: string }[] | null> {
  // Every file this upload replaced (one upload can replace several); the
  // replaces_file_id fallback covers files hidden before superseded_by existed.
  const { rows: restored } = await query<{ id: string; name: string }>(
    `UPDATE files SET is_latest = true, superseded_at = NULL, superseded_by = NULL
     WHERE workspace_id = $1 AND superseded_at IS NOT NULL
       AND (superseded_by = $2
            OR id = (SELECT replaces_file_id FROM files WHERE id = $2 AND workspace_id = $1))
     RETURNING id, name`,
    [workspaceId, fileId],
  );
  if (!restored.length) return null;
  await query('UPDATE files SET replaces_file_id = NULL, version = 1 WHERE id = $1', [fileId]);
  for (const r of restored) await publishFileStatus(workspaceId, { fileId: r.id, status: 'ready', name: r.name });
  return restored;
}

/** Sweep: auto-replaced files past the grace period are deleted for good. */
export async function purgeSupersededFiles(): Promise<number> {
  const { rows } = await query<{ id: string; disk_path: string }>(
    `DELETE FROM files WHERE superseded_at IS NOT NULL
       AND superseded_at < now() - make_interval(days => $1)
     RETURNING id, disk_path`,
    [SUPERSEDED_KEEP_DAYS],
  );
  for (const r of rows) await deleteStoredFile(r.disk_path).catch(() => undefined);
  return rows.length;
}
