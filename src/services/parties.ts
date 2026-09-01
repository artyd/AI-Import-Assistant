import { pool, query } from '../db/pool.js';
import type { WorkspaceRow } from './workspaceAccess.js';

/**
 * Workspace parties. The deal is modelled as three fixed slots:
 *   sender       — Від кого   (постачальник / продавець / shipper)
 *   intermediary — Через кого (посередник / агент)   — optional
 *   recipient    — Кому       (покупець / вантажоодержувач / importer)
 * Our own company is any slot flagged is_internal (usually intermediary or
 * recipient). Validation only *warns*, it never hard-fails, so real-world edge
 * cases don't block intake.
 */

export type PartyRole = 'sender' | 'intermediary' | 'recipient';
export const PARTY_ROLES: readonly PartyRole[] = ['sender', 'intermediary', 'recipient'] as const;

export interface PartyInput {
  // Accepts any label (canonicalRole normalizes to a fixed slot on write).
  role: string;
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

// Free-text/legacy role labels (UA/RU/EN) → the three fixed slots. Used to bucket
// extracted or historical roles when reading; upserts write canonical values.
const ROLE_SYNONYMS: Record<PartyRole, string[]> = {
  sender: [
    'sender', 'від кого', 'вид кого', 'постачальник', 'поставщик', 'продавець', 'продавец',
    'supplier', 'seller', 'shipper', 'вантажовідправник', 'грузоотправитель', 'експортер', 'exporter',
  ],
  intermediary: [
    'intermediary', 'через кого', 'посередник', 'посредник', 'агент', 'agent', 'trader', 'брокер',
  ],
  recipient: [
    'recipient', 'кому', 'покупець', 'покупатель', 'buyer', 'вантажоодержувач', 'грузополучатель',
    'consignee', 'отримувач', 'получатель', 'імпортер', 'importer', 'our_company',
    'наша компанія', 'наша компания',
  ],
};

/** Maps any role label to one of the three fixed slots (null if unrecognised). */
export function canonicalRole(role: string | null | undefined): PartyRole | null {
  if (!role) return null;
  const r = role.trim().toLowerCase();
  if ((PARTY_ROLES as readonly string[]).includes(r)) return r as PartyRole;
  for (const slot of PARTY_ROLES) {
    if (ROLE_SYNONYMS[slot].includes(r)) return slot;
  }
  return null;
}

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
      const role = canonicalRole(p.role) ?? p.role;
      const { rows } = await client.query<PartyRow>(
        `INSERT INTO parties (workspace_id, role, company_name, is_internal, country, contact_info)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id, role, company_name, is_internal, country, contact_info`,
        [
          workspaceId,
          role,
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

/** Non-fatal validation of a parties set against the three fixed slots. */
export function validateParties(
  contractType: 'bilateral' | 'trilateral' | null,
  parties: PartyInput[],
): string[] {
  const warnings: string[] = [];
  const count = (role: PartyRole): number =>
    parties.filter((p) => canonicalRole(p.role) === role).length;

  if (count('sender') === 0) warnings.push('не вказано сторону «Від кого» (постачальник)');
  if (count('recipient') === 0) warnings.push('не вказано сторону «Кому» (одержувач)');
  if (count('sender') > 1) warnings.push('очікується не більше однієї сторони «Від кого»');
  if (count('intermediary') > 1) warnings.push('очікується не більше однієї сторони «Через кого»');
  if (count('recipient') > 1) warnings.push('очікується не більше однієї сторони «Кому»');
  if (contractType === 'trilateral' && count('intermediary') === 0) {
    warnings.push('тристоронній контракт — додайте сторону «Через кого» (посередник)');
  }
  if (contractType === 'bilateral' && count('intermediary') > 0) {
    warnings.push('двосторонній контракт — сторона «Через кого» зайва');
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
  if (!(ws.incoterm_in ?? ws.incoterm)) missing.push('incoterm_in');
  if (!ws.transport_mode) missing.push('transport_mode');
  if (!ws.origin_country) missing.push('origin_country');

  // Need at least a "sender" (Від кого) party. Match canonical + legacy labels.
  const senderLabels = ['sender', ...ROLE_SYNONYMS.sender];
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM parties
     WHERE workspace_id = $1 AND lower(trim(role)) = ANY($2::text[])`,
    [ws.id, senderLabels],
  );
  if ((rows[0]?.n ?? 0) === 0) missing.push('parties');

  return missing;
}

/** True if the role denotes the sender/supplier slot. */
export function isSenderRole(role: string): boolean {
  return canonicalRole(role) === 'sender';
}
