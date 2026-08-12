import { query } from '../db/pool.js';
import type { WorkspaceRow, WorkspaceStatus } from './workspaceAccess.js';
import { computeChecklist, type ChecklistItem } from './checklist.js';
import { computeDiscrepancies, type Discrepancy } from './discrepancies.js';

/**
 * Derived customs-pipeline status. Thresholds are intentionally simple — refine
 * after seeing real data:
 *   draft            — intake not yet complete
 *   docs_in_progress — required documents still missing (or unresolved errors)
 *   docs_complete    — every required doc present, no error-level discrepancies
 *   customs_ready    — every required doc extraction-verified, no error discrepancies
 */
const PIPELINE: WorkspaceStatus[] = [
  'draft',
  'docs_in_progress',
  'docs_complete',
  'customs_ready',
];

export function deriveWorkspaceStatus(
  ws: Pick<WorkspaceRow, 'intake_complete'>,
  checklist: ChecklistItem[],
  discrepancies: Discrepancy[],
): WorkspaceStatus {
  if (!ws.intake_complete) return 'draft';
  if (checklist.length === 0) return 'docs_in_progress';

  const anyMissing = checklist.some((i) => i.status === 'missing');
  const hasErrors = discrepancies.some((d) => d.severity === 'error');
  if (anyMissing) return 'docs_in_progress';

  const allVerified = checklist.every((i) => i.status === 'verified');
  if (allVerified && !hasErrors) return 'customs_ready';
  if (!hasErrors) return 'docs_complete';
  return 'docs_in_progress';
}

export interface WorkspaceState {
  checklist: ChecklistItem[];
  discrepancies: Discrepancy[];
  status: WorkspaceStatus;
}

/**
 * Recomputes checklist + discrepancies and advances the workspace status FORWARD
 * along the pipeline. It never downgrades, and never overrides a manual terminal
 * `done` (or the legacy set beyond nudging it into the pipeline). A manual
 * override via PATCH /status therefore isn't silently undone by a mere recompute.
 */
export async function refreshWorkspaceState(ws: WorkspaceRow): Promise<WorkspaceState> {
  const checklist = await computeChecklist(ws);
  const discrepancies = await computeDiscrepancies(ws.id);
  const derived = deriveWorkspaceStatus(ws, checklist, discrepancies);

  let status = ws.status;
  if (ws.status !== 'done') {
    const currentRank = PIPELINE.indexOf(ws.status); // -1 for legacy 'active'
    const derivedRank = PIPELINE.indexOf(derived);
    if (derivedRank > currentRank) {
      await query('UPDATE workspaces SET status = $2 WHERE id = $1', [ws.id, derived]);
      status = derived;
    }
  }

  return { checklist, discrepancies, status };
}
