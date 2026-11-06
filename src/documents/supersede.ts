import { query } from '../db/pool.js';
import { publishFileStatus } from '../lib/events/fileStatus.js';
import { deleteStoredFile } from '../lib/storage.js';

/**
 * A corrected re-upload replaces the old file. Users fix a document with errors
 * and upload it again under any name («PL_123_fixed.pdf», «PL 123 (1).pdf»): both
 * stayed «current», the reconciler kept checking the OLD one and the agent mixed
 * them up. After a file is read, an earlier current file that is the SAME document
 * (same type + same number + same seller) is deleted and the new one takes its
 * place. The user chose deletion over keeping a hidden old version (2026-11-06).
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
 * Delete the earlier current files that `fileId` is a new version of. Returns the
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
    await query('DELETE FROM files WHERE id = $1 AND workspace_id = $2', [old.id, workspaceId]);
    await deleteStoredFile(old.disk_path).catch(() => undefined);
    await publishFileStatus(workspaceId, { fileId: old.id, status: 'deleted' });
  }
  await query('UPDATE files SET version = $2 WHERE id = $1', [fileId, version]);
  return older.map((r) => r.name);
}
