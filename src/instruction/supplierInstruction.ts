import type { WorkspaceRow } from '../shipments/workspaceAccess.js';
import { saveArtifact } from '../documents/artifacts.js';
import { prefillDraft } from './prefill.js';
import { listVersions } from './store.js';
import { renderText } from './render.js';
import { missingFields } from './types.js';

/**
 * Supplier instruction letter for the legacy endpoint and the agent tool
 * `generate_supplier_instruction`. Since the instruction builder (TZ §1) it is
 * the SAME deterministic template the constructor renders — no LLM call: the
 * latest saved constructor version if there is one, else a fresh prefill. If
 * required fields are empty we return them (fail loudly, never fabricate).
 */
export interface InstructionResult {
  instruction: string;
  artifactId: string;
  version: number | null;
}
export interface MissingContext {
  missing: string[];
}

/** `view` + `lotId` scope it to one lot of an FCL (spec 006); `ws` is the FCL itself. */
export async function buildSupplierInstruction(
  ws: WorkspaceRow,
  scope: { view: WorkspaceRow; lotId: string | null } = { view: ws, lotId: null },
): Promise<InstructionResult | MissingContext> {
  const [latest] = await listVersions(ws.id, scope.lotId);
  const draft = latest?.draft ?? (await prefillDraft(scope.view, null, { lotId: scope.lotId ?? undefined }));
  const missing = missingFields(draft);
  if (missing.length > 0) return { missing: missing.map((m) => m.label) };
  const instruction = renderText(draft, 'en');
  const { id } = await saveArtifact(ws.id, 'supplier_instruction', instruction, 'md', 'agent');
  return { instruction, artifactId: id, version: latest?.version ?? null };
}
