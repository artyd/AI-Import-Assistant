import { pool, query } from '../db/pool.js';
import type { WorkspaceRow, WorkspaceStatus } from './workspaceAccess.js';
import { listLots, loadFclFiles, type FclFileRow, type LotRow, type LotStatus } from './lots.js';
import { isIntakeComplete, planContextUpdate, deriveTransportMode } from './contextDerive.js';
import { analyzeParties } from '../reconciliation/partyExtraction.js';
import { loadDeriveDocs } from '../reconciliation/incoterms.js';
import { upsertParties } from '../reconciliation/parties.js';
import { requiredDocumentTypes, persistChecklist, type ChecklistItem } from '../reconciliation/checklist.js';
import { computeVerdicts, type ShipmentFile, type ShipmentVerdicts } from '../reconciliation/verdicts.js';
import { registryChecksForDocs, type RegistryFinding } from '../customs/drugRegistry.js';
import { computeFclLevel, findManifestFile, matchHblsToLots, type FclLevelVerdicts, type FclLot } from '../reconciliation/fcl.js';
import type { ManifestLine } from '../reconciliation/manifest.js';
import { readStoredFile } from '../lib/storage.js';
import { parseWorkbook, extractRows } from '../analysis/sheets/parse.js';
import { selectActualSheet } from '../analysis/sheets/selectActualSheet.js';
import { latestApproved } from '../instruction/store.js';
import { transportDocKind } from './lotAssign.js';
import type { Discrepancy } from '../reconciliation/discrepancies.js';
import type { Risk } from '../reconciliation/risks.js';

/**
 * FCL (Збірник) state, spec 006 #03: each lot is a shipment of its own — the
 * same `computeVerdicts` over the lot's files (plus the house bills matched to
 * it) and the lot's context laid over the FCL's — and the FCL level adds the
 * container-wide checks (`reconciliation/fcl.ts`). The FCL status is the worst
 * of them, and like a shipment's it only moves forward.
 */

const PIPELINE: WorkspaceStatus[] = ['draft', 'docs_in_progress', 'docs_complete', 'customs_ready'];

/** The FCL row with a lot's context laid over it: what the shipment verdicts read. */
export function lotWorkspaceView(ws: WorkspaceRow, lot: LotRow): WorkspaceRow {
  const view: WorkspaceRow = {
    ...ws,
    contract_type: lot.contract_type,
    contract_type_source: (lot.contract_type_source as WorkspaceRow['contract_type_source']) ?? null,
    contract_type_reason: lot.contract_type_reason,
    contract_type_confidence: null,
    product_category: lot.product_category ?? ws.product_category,
    incoterm: lot.incoterm_in,
    incoterm_in: lot.incoterm_in,
    incoterm_out: lot.incoterm_out,
    origin_country: lot.origin_country,
    auto_context_fields: lot.auto_fields ?? [],
  };
  return { ...view, intake_complete: isIntakeComplete(view) };
}

export interface LotVerdict {
  lot: LotRow;
  verdicts: ShipmentVerdicts;
  /** Files in the lot's folder. */
  fileCount: number;
  /** The lot's consignee: set by hand, else the recipient read from its documents. */
  consignee: string | null;
  intakeComplete: boolean;
}

export interface FclVerdicts {
  lots: LotVerdict[];
  level: FclLevelVerdicts;
  files: FclFileRow[];
}

function docType(f: FclFileRow): string | null {
  const t = f.fields?.doc_type;
  return typeof t === 'string' ? t : null;
}

/**
 * Lines of the FCL manifest spreadsheet, through the consolidated analysis parser
 * (same actual-sheet choice and columns). null when there is no readable manifest.
 */
export async function loadManifestLines(fileId: string): Promise<ManifestLine[] | null> {
  const { rows } = await query<{ name: string; type: string; disk_path: string }>(
    'SELECT name, type, disk_path FROM files WHERE id = $1',
    [fileId],
  );
  const f = rows[0];
  if (!f || (f.type !== 'xlsx' && f.type !== 'csv')) return null;
  try {
    const sheets = parseWorkbook(await readStoredFile(f.disk_path), f.name);
    const { selected } = selectActualSheet(sheets, new Date());
    if (!selected) return null;
    return extractRows(selected).rows.map((r) => ({ name: r.name, qtyKg: r.qtyKg, unitPrice: r.unitPrice, code: r.uctzedCode ?? null }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Manifest ${fileId} could not be parsed:`, (err as Error).message);
    return null;
  }
}

/** Read-only verdicts of an FCL: every lot + the FCL level. */
export async function loadFclVerdicts(ws: WorkspaceRow, now: number = Date.now()): Promise<FclVerdicts> {
  const [lots, files, { rows: parties }] = await Promise.all([
    listLots(ws.id),
    loadFclFiles(ws.id),
    query<{ lot_id: string | null; role: string; company_name: string }>(
      "SELECT lot_id, role, company_name FROM parties WHERE workspace_id = $1 AND company_name <> '' ORDER BY created_at",
      [ws.id],
    ),
  ]);

  const shapes: FclLot[] = lots.map((l) => ({ id: l.id, name: l.name, supplier_name: l.supplier_name, consignee: l.consignee, derivedStatus: 'draft' }));
  const hblLot = matchHblsToLots(files, shapes);
  const seaLike =
    ws.transport_mode === 'sea' ||
    (ws.transport_mode === null && files.some((f) => docType(f) === 'transport' && transportDocKind(f.file_name, f.fields) === 'hbl'));

  const lotVerdicts: LotVerdict[] = [];
  for (const lot of lots) {
    const view = lotWorkspaceView(ws, lot);
    const required = (await requiredDocumentTypes(view)).filter(
      (k) => k !== 'customs_declaration' && (k !== 'transport' || seaLike),
    );
    const mine = files.filter((f) => f.lot_id === lot.id || hblLot[f.file_id] === lot.id);
    const snapshotFiles: ShipmentFile[] = mine.map((f) => ({ file_id: f.file_id, file_name: f.file_name, folder_name: f.folder_name, fields: f.fields }));

    let registry: RegistryFinding[] = [];
    try {
      registry = await registryChecksForDocs(
        mine
          .filter((f) => f.fields && (docType(f) ?? 'other') !== 'other')
          .map((f) => ({ file_name: f.file_name, fields: f.fields! })),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Registry check failed for lot ${lot.id}:`, (err as Error).message);
    }

    const lotParties = parties.filter((p) => p.lot_id === lot.id);
    const intermediary = lotParties.find((p) => p.role === 'intermediary')?.company_name ?? null;
    const recipient = lotParties.find((p) => p.role === 'recipient')?.company_name ?? null;
    const approvedInstruction = await latestApproved(ws.id, lot.id);
    const verdicts = computeVerdicts({ ws: view, required, files: snapshotFiles, intermediary, approvedInstruction, registry }, now);
    lotVerdicts.push({
      lot,
      verdicts,
      fileCount: files.filter((f) => f.lot_id === lot.id).length,
      consignee: lot.consignee ?? recipient,
      intakeComplete: view.intake_complete,
    });
  }

  const manifestFile = findManifestFile(files);
  const manifestLines = manifestFile ? await loadManifestLines(manifestFile.file_id) : null;

  const fclRecipient = parties.find((p) => p.lot_id === null && p.role === 'recipient')?.company_name ?? null;
  const level = computeFclLevel({
    transport_mode: ws.transport_mode,
    eu_transit: ws.eu_transit,
    consignee: fclRecipient,
    files: files.map((f) => ({ ...f })),
    manifest: manifestFile && manifestLines ? { file_id: manifestFile.file_id, file_name: manifestFile.file_name, lines: manifestLines } : null,
    lots: lotVerdicts.map((v) => ({
      id: v.lot.id,
      name: v.lot.name,
      supplier_name: v.lot.supplier_name,
      consignee: v.consignee,
      derivedStatus: v.verdicts.derivedStatus,
    })),
  });
  return { lots: lotVerdicts, level, files };
}

/** Lot discrepancies and risks, labelled with the lot, after the FCL's own. */
export function flattenFcl(v: FclVerdicts): { discrepancies: (Discrepancy & { lot?: string })[]; risks: Risk[] } {
  const discrepancies: (Discrepancy & { lot?: string })[] = [...v.level.discrepancies];
  const risks: Risk[] = [...v.level.risks];
  for (const l of v.lots) {
    for (const d of l.verdicts.discrepancies) discrepancies.push({ ...d, lot: l.lot.name });
    for (const r of l.verdicts.risks) risks.push({ ...r, code: `${l.lot.id}:${r.code}`, title: `${l.lot.name}: ${r.title}` });
  }
  const rank = { error: 0, warning: 1, info: 2 } as const;
  risks.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { discrepancies, risks };
}

export interface FclState {
  checklist: ChecklistItem[];
  discrepancies: Discrepancy[];
  risks: Risk[];
  status: WorkspaceStatus;
  intakeComplete: boolean;
}

function forward<T extends string>(current: T, derived: T, pipeline: readonly T[]): T {
  const cur = pipeline.indexOf(current);
  return pipeline.indexOf(derived) > cur ? derived : current;
}

/**
 * Recomputes and persists an FCL: each lot's checklist + status (forward-only),
 * the FCL checklist, intake flag and status (forward-only, a manual `done` wins).
 */
export async function refreshFclState(ws: WorkspaceRow): Promise<FclState> {
  const v = await loadFclVerdicts(ws);

  for (const l of v.lots) {
    await persistChecklist(ws.id, l.verdicts.checklist, l.lot.id);
    const next = forward<LotStatus>(l.lot.status, l.verdicts.derivedStatus as LotStatus, PIPELINE as LotStatus[]);
    if (next !== l.lot.status) await query('UPDATE lots SET status = $2 WHERE id = $1', [l.lot.id, next]);
  }
  const fclItems: ChecklistItem[] = v.level.checklist.map((i) => ({ requirement_key: i.requirement_key, status: i.status, source_file_id: i.source_file_id }));
  await persistChecklist(ws.id, fclItems, null);

  const intakeComplete = Boolean(ws.transport_mode) && v.lots.length > 0 && v.lots.every((l) => l.intakeComplete);
  if (intakeComplete !== ws.intake_complete) {
    await query('UPDATE workspaces SET intake_complete = $2 WHERE id = $1', [ws.id, intakeComplete]);
  }
  const derived = intakeComplete ? v.level.derivedStatus : 'draft';
  let status = ws.status;
  if (ws.status !== 'done') {
    const next = forward<WorkspaceStatus>(ws.status, derived, PIPELINE);
    if (next !== ws.status) {
      await query('UPDATE workspaces SET status = $2 WHERE id = $1', [ws.id, next]);
      status = next;
    }
  }
  const { discrepancies, risks } = flattenFcl(v);
  return { checklist: fclItems, discrepancies, risks, status, intakeComplete };
}

/**
 * The FCL autopilot (spec 006 #03): each lot's parties, contract mode, Incoterms
 * and origin from ITS documents, and the FCL's transport mode from the transport
 * papers. Same provenance rules as a shipment: a human value is never overwritten.
 */
export async function autoFillFclContext(ws: WorkspaceRow): Promise<void> {
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))', [`autofill:${ws.id}`]);
    for (const lot of await listLots(ws.id)) {
      const [analysis, docs] = await Promise.all([
        analyzeParties(ws.id, { lotId: lot.id }),
        loadDeriveDocs(ws.id, { lotId: lot.id }),
      ]);
      const view = lotWorkspaceView(ws, lot);
      const plan = planContextUpdate(view, analysis, docs);
      const sets: string[] = [];
      const vals: unknown[] = [lot.id];
      const lotColumns: Record<string, string> = {
        contract_type: 'contract_type',
        contract_type_source: 'contract_type_source',
        contract_type_reason: 'contract_type_reason',
        incoterm_in: 'incoterm_in',
        incoterm_out: 'incoterm_out',
        origin_country: 'origin_country',
      };
      for (const [col, value] of Object.entries(plan.columns)) {
        const target = lotColumns[col];
        if (!target) continue;
        sets.push(`${target} = $${vals.length + 1}`);
        vals.push(value);
      }
      const written = plan.written.filter((f) => f in lotColumns);
      if (written.length > 0) {
        sets.push(`auto_fields = ARRAY(SELECT DISTINCT x FROM unnest(auto_fields || $${vals.length + 1}::text[]) x)`);
        vals.push(written);
      }
      if (sets.length > 0) {
        vals.push(written.map((f) => `manual:${f}`));
        await query(`UPDATE lots SET ${sets.join(', ')} WHERE id = $1 AND NOT (auto_fields && $${vals.length}::text[])`, vals);
      }
      if (plan.parties.length > 0) await upsertParties(ws.id, plan.parties, { onlyIfEmpty: true, lotId: lot.id });
    }

    // FCL level: only the transport mode is the container's own fact.
    const autoFields = new Set(ws.auto_context_fields ?? []);
    if (!autoFields.has('manual:transport_mode') && (ws.transport_mode === null || autoFields.has('transport_mode'))) {
      const mode = deriveTransportMode(await loadDeriveDocs(ws.id, { transportMarkdown: true }));
      if (mode && mode !== ws.transport_mode) {
        await query(
          `UPDATE workspaces SET transport_mode = $2,
             auto_context_fields = ARRAY(SELECT DISTINCT x FROM unnest(auto_context_fields || ARRAY['transport_mode']) x)
           WHERE id = $1 AND NOT ('manual:transport_mode' = ANY(auto_context_fields))`,
          [ws.id, mode],
        );
      }
    }
  } finally {
    await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`autofill:${ws.id}`]).catch(() => undefined);
    lock.release();
  }
}
