import { pool, query } from '../db/pool.js';
import { getWorkspaceById, type WorkspaceRow } from './workspaceAccess.js';
import { refreshWorkspaceState } from './status.js';
import { analyzeParties } from './partyExtraction.js';
import { loadDeriveDocs } from './incoterms.js';
import {
  deriveIncoterms,
  deriveOriginCountry,
  deriveTransportMode,
  isUiValue,
  AUTO_FIELDS,
  type AutoField,
} from './contextDerive.js';

export { changedFields } from './contextDerive.js';
import { countryToUk } from '../domain/countries.js';
import { upsertParties, type PartyInput } from './parties.js';

/**
 * AUTOPILOT: persist document-derived shipment context so the agent stops asking
 * for what the documents already say. Deterministic (no LLM) — derivations live
 * in `contextDerive.ts` and run over ALL of the shipment's current extractions on
 * every indexed file.
 *
 * Safety invariants:
 *  - Provenance: the autopilot writes a field only when it is empty, or when it
 *    wrote that field itself before (`auto_context_fields`) — so a value derived
 *    from the first indexed file is refined as the rest of the package arrives,
 *    while a manual edit (which removes the field from the list) is never touched.
 *    A legacy value the UI could not have produced (e.g. "CPT - Bila Tserkva…",
 *    "Ukraine") predates provenance and is treated as autopilot-written.
 *  - Manual lock: never touches contract_type when its source is 'sidebar'/'survey'.
 *  - Parties: only auto-populated when NONE exist yet (never clobbers user rows).
 *  - product_category is never guessed (the form changes the code and regime).
 *
 * Best-effort: callers (the indexing worker) wrap this in try/catch.
 */


export async function autoFillWorkspaceContext(workspaceId: string): Promise<void> {
  // The worker indexes several files of one shipment in parallel, and each runs
  // the autopilot. Two overlapping runs used to read the same row and the later
  // write dropped the other's provenance — an early value (incoterm_in = CPT
  // from the first contract) then looked manual and was never refined. One run
  // per shipment at a time: a session advisory lock on a dedicated connection.
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))', [`autofill:${workspaceId}`]);
    await autoFillLocked(workspaceId);
  } finally {
    await lock
      .query('SELECT pg_advisory_unlock(hashtext($1))', [`autofill:${workspaceId}`])
      .catch(() => undefined);
    lock.release();
  }
}

async function autoFillLocked(workspaceId: string): Promise<void> {
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return;

  const [analysis, docs] = await Promise.all([
    analyzeParties(workspaceId),
    loadDeriveDocs(workspaceId, { transportMarkdown: true }),
  ]);

  const sets: string[] = [];
  const vals: unknown[] = [ws.id];
  const add = (col: string, v: unknown): void => {
    sets.push(`${col} = $${vals.length + 1}`);
    vals.push(v);
  };

  // contract_type — only if not manually set, currently null, and detectable.
  const manualMode =
    ws.contract_type_source === 'sidebar' || ws.contract_type_source === 'survey';
  // An AUTO verdict follows the documents as they arrive: the first files read
  // can say "bilateral" (10%) before the resale chain (supplier → Prime → buyer)
  // is indexed — it used to stick forever because only an empty value was set.
  // A manual (sidebar/survey) value is never touched.
  const autoOwned = ws.contract_type === null || ws.contract_type_source === 'auto';
  const autoChanged =
    !!analysis.contract_type &&
    (analysis.contract_type !== ws.contract_type ||
      // REAL column: 0.7 reads back as 0.699999… — compare with a tolerance.
      Math.abs(analysis.contract_type_confidence - (ws.contract_type_confidence ?? -1)) > 0.01);
  if (!manualMode && autoOwned && autoChanged) {
    add('contract_type', analysis.contract_type);
    add('contract_type_source', 'auto');
    add('contract_type_confidence', analysis.contract_type_confidence);
    add('contract_type_reason', analysis.contract_type_reason);
  }
  const mode = manualMode
    ? ws.contract_type
    : autoOwned
      ? (analysis.contract_type ?? ws.contract_type)
      : (ws.contract_type ?? analysis.contract_type);

  const sender = analysis.suggestions.find((s) => s.role === 'sender');
  const intermediary = analysis.suggestions.find((s) => s.role === 'intermediary');
  const recipient = analysis.suggestions.find((s) => s.role === 'recipient');
  const incoterms = deriveIncoterms(docs, mode, intermediary?.company_name ?? null);
  const derived: Record<AutoField, string | null> = {
    incoterm_in: incoterms.incoterm_in,
    incoterm_out: incoterms.incoterm_out,
    transport_mode: deriveTransportMode(docs),
    // Fallback origin = the manufacturer's country (a trader's country is not origin).
    origin_country: deriveOriginCountry(docs, analysis.manufacturer?.country ?? sender?.country ?? null),
    destination_country: countryToUk(recipient?.country ?? null),
  };

  const autoFields = new Set(ws.auto_context_fields ?? []);
  // A `manual:` marker always wins — including a field the user deliberately
  // cleared (null): the autopilot must not refill it.
  const writable = (f: AutoField): boolean =>
    !autoFields.has(`manual:${f}`) && (ws[f] === null || autoFields.has(f) || !isUiValue(f, ws[f]));
  const written: AutoField[] = [];
  let provenanceChanged = false;
  for (const f of Object.keys(derived) as AutoField[]) {
    const v = derived[f];
    if (v === null || !writable(f) || ws[f] === v) continue;
    add(f, v);
    if (f === 'incoterm_in') add('incoterm', v); // legacy column mirrors incoterm_in
    autoFields.add(f);
    written.push(f);
    provenanceChanged = true;
  }
  // Additive: merge into the stored list instead of overwriting it, so the
  // provenance can never be lost even if a write slips past the lock.
  if (provenanceChanged) {
    sets.push(
      `auto_context_fields = ARRAY(SELECT DISTINCT x FROM unnest(auto_context_fields || $${vals.length + 1}::text[]) x)`,
    );
    vals.push(written);
  }

  if (sets.length > 0) {
    // Guard against a manual edit (sidebar / chat) that landed between our read
    // and this write: if any field we are about to set got a `manual:` marker in
    // the meantime, skip this write — the next indexed file re-derives anyway.
    vals.push(written.map((f) => `manual:${f}`));
    await query(
      `UPDATE workspaces SET ${sets.join(', ')}
       WHERE id = $1 AND NOT (auto_context_fields && $${vals.length}::text[])`,
      vals,
    );
  }

  // Parties — only when NONE exist yet, so we never clobber user-entered rows.
  // The emptiness check runs inside upsertParties' locked transaction (a
  // separate count-then-insert raced with concurrent jobs / the user's save).
  const parties: PartyInput[] = analysis.suggestions
    .filter((s) => s.company_name.trim())
    .map((s) => ({
      role: s.role,
      company_name: s.company_name,
      country: s.country ?? null,
      is_internal: false,
    }));
  if (parties.length > 0) await upsertParties(ws.id, parties, { onlyIfEmpty: true });

  // Recompute intake_complete (required-five) + refresh derived checklist/status.
  const merged = await getWorkspaceById(ws.id);
  if (!merged) return;
  const complete = isIntakeComplete(merged);
  if (complete !== merged.intake_complete) {
    await query('UPDATE workspaces SET intake_complete = $2 WHERE id = $1', [ws.id, complete]);
  }
  const finalWs = await getWorkspaceById(ws.id);
  if (finalWs) await refreshWorkspaceState(finalWs);
}

function isIntakeComplete(ws: WorkspaceRow): boolean {
  return Boolean(
    ws.contract_type &&
      ws.product_category &&
      (ws.incoterm_in ?? ws.incoterm) &&
      ws.transport_mode &&
      ws.origin_country,
  );
}

/**
 * SQL fragment for a MANUAL write (sidebar PATCH, intake, chat-confirmed
 * context): replace each edited field's autopilot provenance with a
 * `manual:<field>` marker so the autopilot never overwrites it again. Appends
 * to the caller's `sets`/`vals`.
 */
export function stampManualEdit(fields: string[], sets: string[], vals: unknown[]): void {
  const tracked = fields.filter((f) => AUTO_FIELDS.includes(f as AutoField));
  if (tracked.length === 0) return;
  const p = vals.length + 1;
  sets.push(
    `auto_context_fields = ARRAY(SELECT DISTINCT x FROM unnest(auto_context_fields || $${p + 1}::text[]) x ` +
      `WHERE x <> ALL($${p}::text[]))`,
  );
  vals.push(tracked, tracked.map((f) => `manual:${f}`));
}
