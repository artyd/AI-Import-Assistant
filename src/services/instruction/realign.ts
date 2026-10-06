import { query } from '../../db/pool.js';
import { getWorkspaceById } from '../workspaceAccess.js';
import { listParties, upsertParties, type PartyInput } from '../parties.js';
import { listVersions, setProposals } from './store.js';
import { prefillDraft } from './prefill.js';
import { getPath } from './types.js';

/**
 * Keeps the parties card and the supplier-instruction draft consistent with a
 * contract mode the USER just set (chat survey / sidebar). Before this, saying
 * «у нас двосторонній» changed only the mode: the trader stayed in the
 * «Через кого» slot, the builder kept the trader's Singapore address as the
 * consignee, and the agent could only tell the user to retype the fields.
 */

/**
 * Bilateral with an intermediary on file → that company is in fact the seller
 * (the contract counterparty), so it moves into the «Хто» slot and the
 * intermediary slot is emptied. Returns a note for the agent, or null.
 */
export async function realignPartiesForMode(
  workspaceId: string,
  mode: 'bilateral' | 'trilateral',
): Promise<string | null> {
  if (mode !== 'bilateral') return null; // trilateral: the intermediary can't be inferred
  const parties = await listParties(workspaceId);
  const intermediary = parties.find((p) => p.role === 'intermediary' && p.company_name.trim());
  if (!intermediary) return null;
  const previousSender = parties.find((p) => p.role === 'sender')?.company_name ?? '';
  const next: PartyInput[] = [
    { role: 'sender', company_name: intermediary.company_name, country: intermediary.country ?? null, is_internal: false },
    ...parties
      .filter((p) => p.role !== 'sender' && p.role !== 'intermediary')
      .map((p) => ({ role: p.role, company_name: p.company_name, country: p.country ?? null, is_internal: p.is_internal })),
  ];
  await upsertParties(workspaceId, next);
  return (
    `Сторони оновлено: «Хто» = ${intermediary.company_name} (продавець за контрактом)` +
    (previousSender && previousSender !== intermediary.company_name
      ? `; ${previousSender} — лише виробник, не сторона угоди`
      : '') +
    '; «Через кого» очищено.'
  );
}

// Fields the contract mode decides in the builder.
const PARTY_PATHS = [
  'consignor.name', 'consignor.address', 'consignor.country',
  'consignee.name', 'consignee.address', 'consignee.country',
  'finalConsignee',
] as const;
// Fields a mode change may need to EMPTY: the end-buyer line of a trilateral
// letter, and a country left over from the previous party (Ukrainian address +
// «Singapore» printed together).
const CLEARABLE = new Set<string>(['finalConsignee', 'consignor.country', 'consignee.country']);

/**
 * Re-runs the builder prefill and, for the party fields whose value changed,
 * puts PROPOSALS on the open draft (the user accepts them on the «Інструкція»
 * screen — never silently overwritten). Returns how many were proposed.
 */
export async function proposePartyFieldsForMode(workspaceId: string, mode: 'bilateral' | 'trilateral'): Promise<number> {
  const [latest] = await listVersions(workspaceId);
  // No open draft: the next one is prefilled from the updated parties anyway.
  if (!latest || latest.status !== 'draft') return 0;
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return 0;
  const fresh = await prefillDraft(ws);
  const reason = `Режим контракту — ${mode === 'bilateral' ? 'двосторонній' : 'тристоронній'}; значення зі сторін/контракту.`;
  const proposals = PARTY_PATHS.flatMap((path) => {
    const now = String(getPath(latest.draft, path) ?? '');
    const want = String(getPath(fresh, path) ?? '');
    // Propose a change; an empty `want` clears a field the old mode filled
    // (e.g. the end buyer line, which a bilateral letter doesn't have).
    if (now === want || (!want && !CLEARABLE.has(path))) return [];
    return [{ path, value: want, reason }];
  });
  // The hints (mode, intermediary/recipient names behind the consignee toggle)
  // and the toggle position are derived, not user-typed — bring them in line now.
  await query(
    `UPDATE supplier_instructions
     SET draft = jsonb_set(jsonb_set(draft, '{hints}', $3::jsonb), '{consigneeChoice}', to_jsonb($4::text)),
         updated_at = now()
     WHERE workspace_id = $1 AND version = $2 AND status = 'draft'`,
    [workspaceId, latest.version, JSON.stringify(fresh.hints), fresh.consigneeChoice],
  );
  if (!proposals.length) return 0;
  const kept = latest.draft.proposals.filter((p) => !proposals.some((n) => n.path === p.path));
  await setProposals(workspaceId, latest.version, [...kept, ...proposals].slice(-30));
  return proposals.length;
}
