import { query } from '../db/pool.js';
import type { WorkspaceRow, WorkspaceStatus } from './workspaceAccess.js';
import { persistChecklist, type ChecklistItem } from '../reconciliation/checklist.js';
import type { Discrepancy } from '../reconciliation/discrepancies.js';
import type { Risk } from '../reconciliation/risks.js';
import { computeVerdicts, loadShipmentSnapshot } from '../reconciliation/verdicts.js';

export { deriveWorkspaceStatus } from '../reconciliation/verdicts.js';

const PIPELINE: WorkspaceStatus[] = [
  'draft',
  'docs_in_progress',
  'docs_complete',
  'customs_ready',
];

export interface WorkspaceState {
  checklist: ChecklistItem[];
  discrepancies: Discrepancy[];
  risks: Risk[];
  status: WorkspaceStatus;
}

/**
 * Recomputes the shipment verdicts, persists the checklist, and advances the
 * workspace status FORWARD along the pipeline. It never downgrades, and never
 * overrides a manual terminal `done` (or the legacy set beyond nudging it into
 * the pipeline). A manual override via PATCH /status therefore isn't silently
 * undone by a mere recompute.
 */
export async function refreshWorkspaceState(ws: WorkspaceRow): Promise<WorkspaceState> {
  if (ws.kind === 'fcl') {
    // Lazy: fclState imports this module's neighbours; an FCL is judged per lot.
    const { refreshFclState } = await import('./fclState.js');
    const s = await refreshFclState(ws);
    return { checklist: s.checklist, discrepancies: s.discrepancies, risks: s.risks, status: s.status };
  }
  const snapshot = await loadShipmentSnapshot(ws);
  const { checklist, discrepancies, risks, derivedStatus } = computeVerdicts(snapshot);
  // No matching templates → nothing to persist (the previous rows stay as they were).
  if (snapshot.required.length > 0) await persistChecklist(ws.id, checklist);

  let status = ws.status;
  if (ws.status !== 'done') {
    const currentRank = PIPELINE.indexOf(ws.status); // -1 for legacy 'active'
    const derivedRank = PIPELINE.indexOf(derivedStatus);
    if (derivedRank > currentRank) {
      await query('UPDATE workspaces SET status = $2 WHERE id = $1', [ws.id, derivedStatus]);
      status = derivedStatus;
    }
  }

  return { checklist, discrepancies, risks, status };
}
