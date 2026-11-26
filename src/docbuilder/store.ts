import { query } from '../db/pool.js';
import { parseData, type DocData, type DocKind, type DocStatus } from './schema.js';
import { documentTitle } from './fromContract.js';

/** Persistence of builder documents — shared by the routes and Штурман's tools. */
export interface DocRow {
  id: string;
  kind: DocKind;
  number: string;
  title: string;
  data: unknown;
  contract_id: string | null;
  status: DocStatus;
  version: number;
  parent_id: string | null;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export function docOut(r: DocRow) {
  return {
    id: r.id,
    kind: r.kind,
    number: r.number,
    title: r.title,
    data: parseData(r.kind, r.data),
    contractId: r.contract_id,
    status: r.status,
    version: r.version,
    parentId: r.parent_id,
    workspaceId: r.workspace_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function logEvent(documentId: string, userId: string | null | undefined, action: string, note = ''): Promise<void> {
  await query('INSERT INTO doc_document_events (document_id, user_id, action, note) VALUES ($1, $2, $3, $4)', [documentId, userId ?? null, action, note]).catch(() => undefined);
}

export async function loadRow(id: string): Promise<DocRow | null> {
  const { rows } = await query<DocRow>('SELECT * FROM doc_documents WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function insertDoc(
  kind: DocKind,
  data: DocData,
  opts: { contractId?: string | null; parentId?: string | null; version?: number; workspaceId?: string | null; userId: string | null },
): Promise<DocRow> {
  const { rows } = await query<DocRow>(
    `INSERT INTO doc_documents (kind, number, title, data, contract_id, parent_id, version, workspace_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [kind, data.number, documentTitle(kind, data), data, opts.contractId ?? null, opts.parentId ?? null, opts.version ?? 1, opts.workspaceId ?? null, opts.userId],
  );
  return rows[0]!;
}

/** The latest document of a kind whose number (or contract number, for an annex) matches. */
export async function findByNumber(kinds: DocKind[], number: string): Promise<DocRow | null> {
  const n = number.trim().toLowerCase();
  if (!n) return null;
  const { rows } = await query<DocRow>(
    `SELECT * FROM doc_documents WHERE kind = ANY($1) AND lower(number) = $2 ORDER BY version DESC, updated_at DESC LIMIT 1`,
    [kinds, n],
  );
  return rows[0] ?? null;
}
