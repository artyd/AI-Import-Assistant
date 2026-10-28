import { pool, query } from '../db/pool.js';
import { sameCompany } from './contextDerive.js';
import { FCL_FOLDER_SKELETON, fclFolderRole, lotFolderName, type FclFolderRole } from './folders.js';
import { buildLotProfiles, lotNameFor, type AssignFields, type LotProfile } from './lotAssign.js';
import { findProductFolder, productKey, type ProductFolder, type ProductRef } from './fclLayout.js';

/**
 * Lots of an FCL (Збірник, spec 006/007): the Postgres side. A lot has its root
 * folder («Партія — <name>», role 'lot') with a sub-folder per product, plus its
 * own folder under «Митниця» (role 'lot_customs'). Every one of them carries the
 * lot's id — a file's lot is its folder's lot.
 */

export type LotStatus = 'draft' | 'docs_in_progress' | 'docs_complete' | 'customs_ready';

export interface LotRow {
  id: string;
  workspace_id: string;
  name: string;
  supplier_name: string;
  supplier_key: string;
  consignee: string | null;
  incoterm_in: string | null;
  incoterm_out: string | null;
  product_category: string | null;
  origin_country: string | null;
  contract_type: 'bilateral' | 'trilateral' | null;
  contract_type_source: string | null;
  contract_type_reason: string | null;
  status: LotStatus;
  source: 'auto' | 'manual';
  auto_fields: string[];
  position: number;
  created_at: string;
}

export async function listLots(workspaceId: string): Promise<LotRow[]> {
  const { rows } = await query<LotRow>(
    'SELECT * FROM lots WHERE workspace_id = $1 ORDER BY position, created_at',
    [workspaceId],
  );
  return rows;
}

export async function getLot(workspaceId: string, lotId: string): Promise<LotRow | null> {
  const { rows } = await query<LotRow>('SELECT * FROM lots WHERE id = $1 AND workspace_id = $2', [lotId, workspaceId]);
  return rows[0] ?? null;
}

/** Lowercased alphanumerics of a supplier name — a stable de-dupe key. */
export function supplierKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The id of the lot's folder. */
export async function lotFolderId(lotId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM folders WHERE lot_id = $1 AND parent_id IS NULL LIMIT 1',
    [lotId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Creates a lot + its folder, or returns the existing lot of the same supplier.
 * Serialised per FCL by an advisory lock: several ingest jobs of one upload can
 * see the same new supplier at once, and must end up in ONE lot.
 */
export async function ensureLot(
  workspaceId: string,
  supplierName: string,
  source: 'auto' | 'manual',
  name?: string,
): Promise<{ lot: LotRow; folderId: string; created: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('lots:' || $1))", [workspaceId]);
    const { rows: existing } = await client.query<LotRow>(
      'SELECT * FROM lots WHERE workspace_id = $1 ORDER BY position, created_at',
      [workspaceId],
    );
    const same = supplierName ? existing.find((l) => l.supplier_name && sameCompany(l.supplier_name, supplierName)) : undefined;
    if (same) {
      const { rows: fo } = await client.query<{ id: string }>(
        'SELECT id FROM folders WHERE lot_id = $1 AND parent_id IS NULL LIMIT 1',
        [same.id],
      );
      let folderId = fo[0]?.id;
      if (!folderId) folderId = await insertLotFolder(client, workspaceId, same);
      await client.query('COMMIT');
      return { lot: same, folderId, created: false };
    }
    const position = existing.reduce((m, l) => Math.max(m, l.position + 1), 0);
    const { rows } = await client.query<LotRow>(
      `INSERT INTO lots (workspace_id, name, supplier_name, supplier_key, source, position)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [workspaceId, name ?? lotNameFor(supplierName), supplierName, supplierKey(supplierName), source, position],
    );
    const lot = rows[0]!;
    const folderId = await insertLotFolder(client, workspaceId, lot);
    await client.query('COMMIT');
    return { lot, folderId, created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertLotFolder(
  client: { query: typeof pool.query },
  workspaceId: string,
  lot: Pick<LotRow, 'id' | 'name'>,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO folders (workspace_id, name, position, lot_id, role)
     VALUES ($1, $2, COALESCE((SELECT MAX(position) + 1 FROM folders WHERE workspace_id = $1), 0), $3, 'lot')
     RETURNING id`,
    [workspaceId, lotFolderName(lot.name), lot.id],
  );
  return rows[0]!.id;
}

/** The FCL-level folder of a role (manifest / transport / customs), created when missing. */
export async function fclFolderId(workspaceId: string, role: FclFolderRole): Promise<string> {
  const { rows } = await query<{ id: string; name: string }>(
    'SELECT id, name FROM folders WHERE workspace_id = $1 AND lot_id IS NULL AND parent_id IS NULL ORDER BY position',
    [workspaceId],
  );
  const hit = rows.find((f) => fclFolderRole(f.name) === role);
  if (hit) return hit.id;
  const name = FCL_FOLDER_SKELETON.find((n) => fclFolderRole(n) === role)!;
  const { rows: created } = await query<{ id: string }>(
    `INSERT INTO folders (workspace_id, name, position)
     VALUES ($1, $2, COALESCE((SELECT MAX(position) + 1 FROM folders WHERE workspace_id = $1), 0))
     RETURNING id`,
    [workspaceId, name],
  );
  return created[0]!.id;
}

/** The lot's folder under «Митниця» (invoices, packing lists, contract…), created when missing. */
export async function lotCustomsFolderId(workspaceId: string, lot: { id: string; name: string }): Promise<string> {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM folders WHERE lot_id = $1 AND role = 'lot_customs' LIMIT 1",
    [lot.id],
  );
  if (rows[0]) return rows[0].id;
  const customs = await fclFolderId(workspaceId, 'customs');
  return withFolderLock(workspaceId, async (client) => {
    const again = await client.query<{ id: string }>(
      "SELECT id FROM folders WHERE lot_id = $1 AND role = 'lot_customs' LIMIT 1",
      [lot.id],
    );
    if (again.rows[0]) return again.rows[0].id;
    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO folders (workspace_id, name, position, lot_id, parent_id, role)
       VALUES ($1, $2, COALESCE((SELECT MAX(position) + 1 FROM folders WHERE workspace_id = $1), 0), $3, $4, 'lot_customs')
       RETURNING id`,
      [workspaceId, lot.name, lot.id, customs],
    );
    return created[0]!.id;
  });
}

/** The product folders of a lot. */
export async function listProductFolders(lotId: string): Promise<(ProductFolder & { name: string })[]> {
  const { rows } = await query<ProductFolder & { name: string }>(
    "SELECT id, name, COALESCE(product_key, name) AS product_key FROM folders WHERE lot_id = $1 AND role = 'product' ORDER BY position",
    [lotId],
  );
  return rows;
}

/**
 * The folder of one product of a lot. With `create`, a product that has no
 * folder yet gets one (only the anchor documents create products).
 */
export async function productFolderId(
  workspaceId: string,
  lotId: string,
  product: ProductRef,
  create: boolean,
): Promise<string | null> {
  const hit = findProductFolder(await listProductFolders(lotId), product);
  if (hit || !create) return hit?.id ?? null;
  const parent = await lotFolderId(lotId);
  if (!parent) return null;
  return withFolderLock(workspaceId, async (client) => {
    const { rows } = await client.query<ProductFolder>(
      "SELECT id, COALESCE(product_key, name) AS product_key FROM folders WHERE lot_id = $1 AND role = 'product'",
      [lotId],
    );
    const again = findProductFolder(rows, product);
    if (again) return again.id;
    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO folders (workspace_id, name, position, lot_id, parent_id, role, product_key)
       VALUES ($1, $2, COALESCE((SELECT MAX(position) + 1 FROM folders WHERE workspace_id = $1), 0), $3, $4, 'product', $5)
       RETURNING id`,
      [workspaceId, product.name, lotId, parent, productKey(product)],
    );
    return created[0]!.id;
  });
}

/** Folder creation serialised per workspace: concurrent filings must not make twins. */
async function withFolderLock<T>(
  workspaceId: string,
  fn: (client: { query: typeof pool.query }) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('folders:' || $1))", [workspaceId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Replaces the extra places (product folders) a file is linked into. */
export async function setFileLinks(fileId: string, folderIds: string[]): Promise<void> {
  await query('DELETE FROM file_links WHERE file_id = $1', [fileId]);
  for (const folderId of new Set(folderIds)) {
    await query('INSERT INTO file_links (file_id, folder_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fileId, folderId]);
  }
}

/** One latest file of an FCL with its lot (through the folder) and extraction. */
export interface FclFileRow {
  file_id: string;
  file_name: string;
  file_type: string;
  folder_id: string | null;
  folder_name: string | null;
  lot_id: string | null;
  fields: Record<string, unknown> | null;
}

export async function loadFclFiles(workspaceId: string): Promise<FclFileRow[]> {
  const { rows } = await query<FclFileRow>(
    `SELECT f.id AS file_id, f.name AS file_name, f.type AS file_type, f.folder_id,
            fo.name AS folder_name, fo.lot_id, de.extracted_fields AS fields
     FROM files f
     LEFT JOIN folders fo ON fo.id = f.folder_id
     LEFT JOIN document_extractions de ON de.file_id = f.id
     WHERE f.workspace_id = $1 AND f.is_latest = true
     ORDER BY f.created_at, f.name, f.id`,
    [workspaceId],
  );
  return rows;
}

export async function loadLotProfiles(workspaceId: string): Promise<LotProfile[]> {
  const [lots, files] = await Promise.all([listLots(workspaceId), loadFclFiles(workspaceId)]);
  return buildLotProfiles(lots, files.map((f) => ({ lot_id: f.lot_id, fields: f.fields as AssignFields | null })));
}
