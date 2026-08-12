import { pool, query } from '../db/pool.js';
import type { WorkspaceRow } from './workspaceAccess.js';

/**
 * Workspace parties (our company / supplier / intermediary). Roles are a flexible
 * set — validation only *warns* about unusual combinations, it never hard-fails,
 * so real-world edge cases don't block intake.
 */

export type PartyRole = 'our_company' | 'supplier' | 'intermediary';

export interface PartyInput {
  role: PartyRole;
  company_name: string;
  is_internal?: boolean;
  country?: string | null;
  contact_info?: Record<string, unknown>;
}

export interface PartyRow {
  id: string;
  role: PartyRole;
  company_name: string;
  is_internal: boolean;
  country: string | null;
  contact_info: Record<string, unknown>;
}

const INTERNAL_COMPANIES = ['AGroup95', 'PrimeForce'];

/** Replaces the workspace's parties atomically with the supplied set. */
export async function upsertParties(
  workspaceId: string,
  parties: PartyInput[],
): Promise<PartyRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM parties WHERE workspace_id = $1', [workspaceId]);
    const out: PartyRow[] = [];
    for (const p of parties) {
      const { rows } = await client.query<PartyRow>(
        `INSERT INTO parties (workspace_id, role, company_name, is_internal, country, contact_info)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id, role, company_name, is_internal, country, contact_info`,
        [
          workspaceId,
          p.role,
          p.company_name,
          p.is_internal ?? false,
          p.country ?? null,
          JSON.stringify(p.contact_info ?? {}),
        ],
      );
      out.push(rows[0]!);
    }
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Non-fatal validation of a parties set against the contract type. */
export function validateParties(
  contractType: 'bilateral' | 'trilateral' | null,
  parties: PartyInput[],
): string[] {
  const warnings: string[] = [];
  const count = (role: PartyRole): number => parties.filter((p) => p.role === role).length;

  if (contractType === 'bilateral') {
    if (count('our_company') !== 1) warnings.push('bilateral: очікується рівно 1 our_company');
    if (count('supplier') !== 1) warnings.push('bilateral: очікується рівно 1 supplier');
    if (count('intermediary') > 0) warnings.push('bilateral: intermediary зайвий');
  } else if (contractType === 'trilateral') {
    if (count('our_company') !== 1) warnings.push('trilateral: очікується рівно 1 our_company');
    if (count('intermediary') !== 1) warnings.push('trilateral: очікується рівно 1 intermediary');
    if (count('supplier') !== 1) warnings.push('trilateral: очікується рівно 1 supplier');
  }

  for (const p of parties) {
    if (p.is_internal && !INTERNAL_COMPANIES.includes(p.company_name)) {
      warnings.push(`is_internal=true, але company_name "${p.company_name}" не з {AGroup95, PrimeForce}`);
    }
  }
  return warnings;
}

export async function listParties(workspaceId: string): Promise<PartyRow[]> {
  const { rows } = await query<PartyRow>(
    `SELECT id, role, company_name, is_internal, country, contact_info
     FROM parties WHERE workspace_id = $1 ORDER BY role`,
    [workspaceId],
  );
  return rows;
}

/** Which intake dimensions are still unset (used by the agent's get_missing_context). */
export async function getMissingContext(ws: WorkspaceRow): Promise<string[]> {
  const missing: string[] = [];
  if (!ws.contract_type) missing.push('contract_type');
  if (!ws.product_category) missing.push('product_category');
  if (!ws.incoterm) missing.push('incoterm');
  if (!ws.transport_mode) missing.push('transport_mode');
  if (!ws.origin_country) missing.push('origin_country');

  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM parties WHERE workspace_id = $1 AND role = 'supplier'`,
    [ws.id],
  );
  if ((rows[0]?.n ?? 0) === 0) missing.push('parties');

  return missing;
}
