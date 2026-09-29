import { query } from '../db/pool.js';
import { getWorkspaceById } from './workspaceAccess.js';
import { refreshWorkspaceState } from './status.js';
import { analyzeParties } from './partyExtraction.js';
import { suggestIncoterms } from './incoterms.js';
import { upsertParties, type PartyInput } from './parties.js';

/**
 * AUTOPILOT: persist document-derived shipment context so the agent stops asking
 * for what the documents already say. Deterministic (no LLM) — it reuses the
 * existing derivations (`analyzeParties` / `suggestIncoterms`) that were previously
 * computed only on-demand and never written to the DB.
 *
 * Safety invariants:
 *  - NULL-only: never overwrites a field that already has a value.
 *  - Manual lock: never touches contract_type when its source is 'sidebar'/'survey'.
 *  - Parties: only auto-populated when NONE exist yet (never clobbers user rows).
 *
 * Best-effort: callers (the indexing worker) wrap this in try/catch.
 */
export async function autoFillWorkspaceContext(workspaceId: string): Promise<void> {
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return;

  const analysis = await analyzeParties(workspaceId);
  const incoterms = await suggestIncoterms(workspaceId);

  const sets: string[] = [];
  const vals: unknown[] = [ws.id];
  const add = (col: string, v: unknown): void => {
    sets.push(`${col} = $${vals.length + 1}`);
    vals.push(v);
  };

  // contract_type — only if not manually set, currently null, and detectable.
  const manualMode =
    ws.contract_type_source === 'sidebar' || ws.contract_type_source === 'survey';
  if (!manualMode && !ws.contract_type && analysis.contract_type) {
    add('contract_type', analysis.contract_type);
    add('contract_type_source', 'auto');
    add('contract_type_confidence', analysis.contract_type_confidence);
    add('contract_type_reason', analysis.contract_type_reason);
  }

  // Incoterms — NULL-only; keep legacy `incoterm` synced to incoterm_in.
  if (!ws.incoterm_in && incoterms.incoterm_in) {
    add('incoterm_in', incoterms.incoterm_in);
    add('incoterm', incoterms.incoterm_in);
  }
  if (!ws.incoterm_out && incoterms.incoterm_out) add('incoterm_out', incoterms.incoterm_out);

  // origin_country — NULL-only; taken from the derived sender/manufacturer country
  // (which partyExtraction fills from country_of_origin).
  if (!ws.origin_country) {
    const originc = analysis.suggestions.find((s) => s.country)?.country ?? null;
    if (originc) add('origin_country', originc);
  }

  if (sets.length > 0) {
    await query(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = $1`, vals);
  }

  // Parties — only when NONE exist yet, so we never clobber user-entered rows.
  const { rows } = await query<{ n: number }>(
    'SELECT count(*)::int AS n FROM parties WHERE workspace_id = $1',
    [ws.id],
  );
  if ((rows[0]?.n ?? 0) === 0) {
    const parties: PartyInput[] = analysis.suggestions
      .filter((s) => s.company_name.trim())
      .map((s) => ({
        role: s.role,
        company_name: s.company_name,
        country: s.country ?? null,
        is_internal: false,
      }));
    if (parties.length > 0) await upsertParties(ws.id, parties);
  }

  // Recompute intake_complete (required-five) + refresh derived checklist/status.
  const merged = await getWorkspaceById(ws.id);
  if (!merged) return;
  const complete = Boolean(
    merged.contract_type &&
      merged.product_category &&
      (merged.incoterm_in ?? merged.incoterm) &&
      merged.transport_mode &&
      merged.origin_country,
  );
  if (complete !== merged.intake_complete) {
    await query('UPDATE workspaces SET intake_complete = $2 WHERE id = $1', [ws.id, complete]);
  }
  const finalWs = await getWorkspaceById(ws.id);
  if (finalWs) await refreshWorkspaceState(finalWs);
}
