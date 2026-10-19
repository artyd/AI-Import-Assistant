import { query } from '../db/pool.js';
import { getWorkspaceById, type WorkspaceRow } from './workspaceAccess.js';
import { autoFillWorkspaceContext } from './autoContext.js';
import { isIntakeComplete } from './contextDerive.js';
import { refreshWorkspaceState, type WorkspaceState } from './status.js';
import { insertNotification } from '../notifications/notifications.js';

/**
 * Shipment state: the ONE entry point after anything a shipment's verdicts read
 * from has changed — its files, extractions, parties, context or approved
 * instruction. Callers say WHAT changed; this module owns the order:
 *
 *   1. documents / verification → the context autopilot (best-effort)
 *   2. intake_complete from the "required five" (unless the caller set it)
 *   3. the shipment verdicts: checklist persisted, status advanced forward-only
 *   4. optionally, a notification about critical (error-level) risks
 *
 * Rule for new code: every write to those inputs ends with `shipmentChanged`.
 */
export type ShipmentChange =
  /** A file was read: Markdown + extraction stored, maybe auto-filed. */
  | 'documents'
  /** A human confirmed or corrected extracted fields. */
  | 'verification'
  /** Intake / context fields written by hand or by the agent. */
  | 'context'
  /** The parties card was saved. */
  | 'parties'
  /** Files deleted, moved between folders, or a new version uploaded. */
  | 'files'
  /** A supplier instruction was approved / sent (compliance check input). */
  | 'instruction';

export interface ShipmentChangeOptions {
  /** Notify the responsible user about critical risks (single uploads). */
  alertRisks?: boolean;
  /** The caller set intake_complete explicitly — keep it as written. */
  keepIntakeFlag?: boolean;
}

export interface ShipmentChangeResult extends WorkspaceState {
  workspace: WorkspaceRow;
}

const READS_DOCUMENTS: ReadonlySet<ShipmentChange> = new Set(['documents', 'verification']);

export async function shipmentChanged(
  workspaceId: string,
  change: ShipmentChange,
  opts: ShipmentChangeOptions = {},
): Promise<ShipmentChangeResult | null> {
  // 1. Document-derived context (parties, contract mode, Incoterms, origin).
  if (READS_DOCUMENTS.has(change)) {
    try {
      await autoFillWorkspaceContext(workspaceId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Auto-fill context failed for workspace ${workspaceId}:`, (err as Error).message);
    }
  }

  let ws = await getWorkspaceById(workspaceId);
  if (!ws) return null;

  // 2. Intake completeness — one definition for every writer.
  if (!opts.keepIntakeFlag) {
    const complete = isIntakeComplete(ws);
    if (complete !== ws.intake_complete) {
      await query('UPDATE workspaces SET intake_complete = $2 WHERE id = $1', [ws.id, complete]);
      ws = { ...ws, intake_complete: complete };
    }
  }

  // 3. Verdicts.
  const state = await refreshWorkspaceState(ws);
  const workspace = { ...ws, status: state.status };

  // 4. Critical-risk alert. De-duped per (user, workspace, type) per day.
  if (opts.alertRisks && ws.responsible_user_id) {
    const critical = state.risks.filter((r) => r.severity === 'error');
    if (critical.length > 0) {
      await insertNotification(
        ws.responsible_user_id,
        ws.id,
        'risk_alert',
        `Постачання №${ws.number}: критичні ризики (${critical.length}) — ${critical[0]!.title}.`,
      ).catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.error(`Risk alert failed for workspace ${ws!.id}:`, err.message);
      });
    }
  }

  return { ...state, workspace };
}
