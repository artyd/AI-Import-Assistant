import type { WorkspaceRow } from './workspaceAccess.js';
import { saveArtifact } from './artifacts.js';
import { prefillDraft } from './instruction/prefill.js';
import { listVersions } from './instruction/store.js';
import { renderText } from './instruction/render.js';
import { missingFields } from './instruction/types.js';

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

export async function buildSupplierInstruction(ws: WorkspaceRow): Promise<InstructionResult | MissingContext> {
  const [latest] = await listVersions(ws.id);
  const draft = latest?.draft ?? (await prefillDraft(ws));
  const missing = missingFields(draft);
  if (missing.length > 0) return { missing: missing.map((m) => m.label) };
  const instruction = renderText(draft, 'en');
  const { id } = await saveArtifact(ws.id, 'supplier_instruction', instruction, 'md', 'agent');
  return { instruction, artifactId: id, version: latest?.version ?? null };
}
