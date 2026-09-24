import { query } from '../db/pool.js';
import { getWorkspaceById } from './workspaceAccess.js';
import { computeDiscrepancies } from './discrepancies.js';
import { computeRisks } from './risks.js';
import { insertNotification } from './notifications.js';

/**
 * Auto-reconcile when an upload batch is fully read (user's "auto-reconcile when
 * ready" + "readiness = ALL files read"). Called after every file finishes (in
 * the worker) and after the retry sweep flags a file — whichever completes the
 * batch last actually fires it. Deterministic: uses computeDiscrepancies +
 * computeRisks (single-agent constraint — no second Claude agent), then drops an
 * in-app notification. The full chat summary / discrepancy table / report doc
 * rendering is the frontend half of this phase; the findings are already
 * available via the discrepancies + ingest-status endpoints.
 *
 * Idempotent: the batch is claimed atomically (reconcile_done flag) so it fires
 * exactly once even if two workers finish the last files concurrently.
 */
export async function maybeReconcileBatch(batchId: string | null | undefined): Promise<boolean> {
  if (!batchId) return false;

  const { rows: bRows } = await query<{ workspace_id: string; reconcile_done: boolean }>(
    'SELECT workspace_id, reconcile_done FROM ingest_batches WHERE id = $1',
    [batchId],
  );
  const batch = bRows[0];
  if (!batch || batch.reconcile_done) return false;

  // Complete = nothing still queued/indexing AND no error file the sweep will
  // still retry (every error is already flagged unreadable → done retrying).
  const { rows: pend } = await query<{ pending: string; retriable: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('queued','indexing')) AS pending,
       COUNT(*) FILTER (WHERE status = 'error' AND extraction_status IS DISTINCT FROM 'unreadable') AS retriable
     FROM files WHERE batch_id = $1 AND is_latest = true`,
    [batchId],
  );
  const p = pend[0]!;
  if (Number(p.pending) > 0 || Number(p.retriable) > 0) return false;

  // Claim atomically so reconciliation runs exactly once for this batch.
  const claim = await query(
    'UPDATE ingest_batches SET reconcile_done = true WHERE id = $1 AND reconcile_done = false',
    [batchId],
  );
  if ((claim.rowCount ?? 0) === 0) return false;

  const ws = await getWorkspaceById(batch.workspace_id);
  if (!ws) return false;

  const discrepancies = await computeDiscrepancies(ws.id).catch(() => []);
  const risks = await computeRisks(ws).catch(() => []);
  const confirmed = discrepancies.filter((d) => d.kind === 'confirmed').length;
  const critical = risks.filter((r) => r.severity === 'error').length;

  const { rows: flagged } = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM files
     WHERE batch_id = $1 AND is_latest = true
       AND (status = 'error' OR extraction_status = 'unreadable')`,
    [batchId],
  );
  const needsManual = Number(flagged[0]!.n);

  if (ws.responsible_user_id) {
    const parts = [
      `Постачання №${ws.number}: звірку виконано`,
      `${discrepancies.length} розбіжностей (${confirmed} підтверджених)`,
      critical > 0 ? `${critical} критичних ризиків` : null,
      needsManual > 0 ? `${needsManual} файл(ів) потребують ручного вводу` : null,
    ].filter(Boolean);
    await insertNotification(
      ws.responsible_user_id,
      ws.id,
      'reconcile_ready',
      `${parts.join(' · ')}.`,
    );
  }

  return true;
}
