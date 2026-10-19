import { pool, query } from '../db/pool.js';
import { getWorkspaceById, type WorkspaceRow } from './workspaceAccess.js';
import { analyzeParties } from '../reconciliation/partyExtraction.js';
import { loadDeriveDocs } from '../reconciliation/incoterms.js';
import { upsertParties } from '../reconciliation/parties.js';
import { AUTO_FIELDS, changedFields, planContextUpdate, type AutoField } from './contextDerive.js';

export { changedFields } from './contextDerive.js';

/**
 * AUTOPILOT: persist document-derived shipment context so the agent stops asking
 * for what the documents already say. Deterministic (no LLM): the decision is
 * `planContextUpdate` (`contextDerive.ts`, pure, with the provenance rules);
 * this module only loads its inputs and applies the plan. Recomputing intake
 * and the verdicts afterwards is `shipmentChanged` (`state.ts`).
 *
 * Best-effort: `shipmentChanged` wraps it in try/catch.
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
  const plan = planContextUpdate(ws, analysis, docs);

  const sets: string[] = [];
  const vals: unknown[] = [ws.id];
  for (const [col, v] of Object.entries(plan.columns)) {
    sets.push(`${col} = $${vals.length + 1}`);
    vals.push(v);
  }
  // Additive: merge into the stored list instead of overwriting it, so the
  // provenance can never be lost even if a write slips past the lock.
  if (plan.written.length > 0) {
    sets.push(
      `auto_context_fields = ARRAY(SELECT DISTINCT x FROM unnest(auto_context_fields || $${vals.length + 1}::text[]) x)`,
    );
    vals.push(plan.written);
  }
  if (sets.length > 0) {
    // Guard against a manual edit (sidebar / chat) that landed between our read
    // and this write: if any field we are about to set got a `manual:` marker in
    // the meantime, skip this write — the next indexed file re-derives anyway.
    vals.push(plan.written.map((f) => `manual:${f}`));
    await query(
      `UPDATE workspaces SET ${sets.join(', ')}
       WHERE id = $1 AND NOT (auto_context_fields && $${vals.length}::text[])`,
      vals,
    );
  }

  // Parties — only when NONE exist yet, so we never clobber user-entered rows.
  // The emptiness check runs inside upsertParties' locked transaction (a
  // separate count-then-insert raced with concurrent jobs / the user's save).
  if (plan.parties.length > 0) await upsertParties(ws.id, plan.parties, { onlyIfEmpty: true });
}

/**
 * SQL fragment for a MANUAL write: replace each edited field's autopilot
 * provenance with a `manual:<field>` marker so the autopilot never overwrites
 * it again. Appends to the caller's `sets`/`vals`.
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

/** Who made a manual context write; decides the contract-mode provenance stamp. */
export type ManualSource =
  | { by: 'sidebar' }
  | { by: 'survey'; reason: string };

/**
 * One manual (human) context write — the shipment card, the intake form, or
 * context the user confirmed in chat. Writes the given columns, stamps the
 * contract-mode lock and the `manual:` provenance markers, and keeps the legacy
 * `incoterm` column in line with `incoterm_in`. `columns` may carry other
 * whitelisted workspace columns (number, supplier…) — they are written as is.
 */
export async function writeManualContext(
  ws: WorkspaceRow,
  columns: Record<string, unknown>,
  source: ManualSource,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [ws.id];
  for (const [key, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    sets.push(`${key} = $${vals.length + 1}`);
    vals.push(value);
  }
  // A manual contract_type locks provenance against auto-detection.
  const ct = columns.contract_type as 'bilateral' | 'trilateral' | null | undefined;
  if (ct !== undefined) {
    const set = ct !== null;
    const stamp: [string, unknown][] =
      source.by === 'sidebar'
        ? [
            ['contract_type_source', set ? 'sidebar' : null],
            ['contract_type_confidence', null], // a human choice carries no numeric confidence
            ['contract_type_reason', set ? 'Встановлено вручну.' : null],
          ]
        : [
            ['contract_type_source', 'survey'],
            ['contract_type_confidence', null],
            ['contract_type_reason', source.reason],
          ];
    for (const [col, v] of stamp) {
      sets.push(`${col} = $${vals.length + 1}`);
      vals.push(v);
    }
  }
  // Fields the user set by hand are off-limits to the document autopilot.
  stampManualEdit(changedFields(ws, columns), sets, vals);
  if (sets.length > 0) {
    await query(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = $1`, vals);
  }
  if (columns.incoterm_in !== undefined) {
    await query('UPDATE workspaces SET incoterm = incoterm_in WHERE id = $1', [ws.id]);
  }
}
