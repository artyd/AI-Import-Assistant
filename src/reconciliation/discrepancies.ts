import { reconcile, type Discrepancy, type ReconcileDoc } from './reconcile.js';
import { checkBankAccounts } from './documentChecks.js';
import { checkInstructionCompliance } from '../instruction/compliance.js';
import type { InstructionVersion } from '../instruction/store.js';
import type { WorkspaceRow } from '../shipments/workspaceAccess.js';

/**
 * Shipment-scoped cross-document reconciliation: the latest structured
 * extractions go to the pure `reconcile()` core (`reconcile.ts`), plus the
 * approved supplier instruction's compliance check. It NEVER re-reads raw
 * document text — findings are a pure function of `document_extractions`
 * (loaded once by `verdicts.ts`).
 *
 * The ranking contract (🔴 confirmed with two citations / 🟡 suspected) lives in
 * `reconcile.ts`; see there for the full rationale.
 */

// Re-export the finding types so existing consumers keep importing them from here.
export type {
  Severity,
  FlagKind,
  DiscrepancyCitation,
  Discrepancy,
} from './reconcile.js';

export interface DiscrepancyContext {
  ws: Pick<WorkspaceRow, 'contract_type' | 'incoterm_in' | 'incoterm' | 'incoterm_out'> & Partial<Pick<WorkspaceRow, 'kind'>>;
  intermediary: string | null;
  approvedInstruction: InstructionVersion | null;
}

export function findDiscrepancies(
  docs: ReconcileDoc[],
  { ws, intermediary, approvedInstruction }: DiscrepancyContext,
): Discrepancy[] {
  // Pass the shipment's contract mode + Incoterms so trilateral (3-party) gets
  // the two-leg checks; bilateral/unknown keeps the single-invoice behaviour.
  const findings = reconcile(docs, {
    contractMode: ws.contract_type ?? null,
    // Trilateral: the shipment's single Incoterm is usually the SALE term (CPT
    // to the consignee) — never use it as the buy-side term of the inbound leg
    // («Метопрен»: CPT Біла Церква vs the supplier's FCA Mumbai, a false warning).
    incotermIn: ws.incoterm_in ?? (ws.contract_type === 'trilateral' ? null : ws.incoterm) ?? null,
    incotermOut: ws.incoterm_out ?? null,
    intermediaryName: intermediary,
    // A Збірник's lots are reconciled one by one; a plain shipment holding
    // several suppliers' papers is a consolidation and is not cross-compared.
    singleShipment: ws.kind !== undefined && ws.kind !== 'fcl',
  });
  // Bank details of one seller must agree across its payment documents.
  findings.push(...checkBankAccounts(docs));
  // Did the supplier follow our approved instruction? (no-op until one is approved
  // and shipping documents have arrived)
  if (approvedInstruction) {
    findings.push(...checkInstructionCompliance(approvedInstruction.draft, docs, approvedInstruction.version));
  }
  return findings;
}
