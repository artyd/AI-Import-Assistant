import { anthropic, MODEL } from '../anthropic/client.js';
import { query } from '../db/pool.js';
import type { WorkspaceRow } from './workspaceAccess.js';
import { saveArtifact } from './artifacts.js';
import { isSenderRole } from './parties.js';

/**
 * Generates a supplier instruction letter (Markdown) from the workspace intake
 * context + parties. Required context is validated up front; if anything is
 * missing we return the list so the caller can 400 (fail loudly rather than
 * fabricate — the "ask instead of guess" chat UX is Phase 4).
 */

export interface InstructionResult {
  instruction: string;
  artifactId: string;
}
export interface MissingContext {
  missing: string[];
}

interface PartyRow {
  role: string;
  company_name: string;
  country: string | null;
}

function requiredMissing(ws: WorkspaceRow, parties: PartyRow[]): string[] {
  const missing: string[] = [];
  if (!ws.product_category) missing.push('product_category');
  if (!ws.origin_country) missing.push('origin_country');
  if (!(ws.incoterm_in ?? ws.incoterm)) missing.push('incoterm_in');
  if (!ws.transport_mode) missing.push('transport_mode');
  if (!parties.some((p) => isSenderRole(p.role))) missing.push('supplier_party');
  return missing;
}

// Selectable letter sections (the constructor UI toggles these). Order matters.
export const INSTRUCTION_SECTIONS = [
  'documents',
  'invoice_packing',
  'marking',
  'certificates',
  'timelines',
] as const;
export type InstructionSection = (typeof INSTRUCTION_SECTIONS)[number];

const SECTION_TEXT: Record<InstructionSection, string> = {
  documents:
    'перелік обовʼязкових документів (інвойс, пакувальний лист, PO, сертифікат ' +
    'походження, сертифікати якості, транспортні документи)',
  invoice_packing: 'вимоги до інвойсу та пакувального листа (реквізити, відповідність сум і ваги)',
  marking: 'вимоги до маркування, палет, фото',
  certificates: 'вимоги до сертифікатів',
  timelines: 'орієнтовні терміни надання',
};

export async function buildSupplierInstruction(
  ws: WorkspaceRow,
  options: { sections?: InstructionSection[] } = {},
): Promise<InstructionResult | MissingContext> {
  const { rows: parties } = await query<PartyRow>(
    'SELECT role, company_name, country FROM parties WHERE workspace_id = $1',
    [ws.id],
  );

  const missing = requiredMissing(ws, parties);
  if (missing.length > 0) return { missing };

  // Default to all sections; the constructor can pass a subset.
  const chosen =
    options.sections && options.sections.length > 0
      ? INSTRUCTION_SECTIONS.filter((s) => options.sections!.includes(s))
      : [...INSTRUCTION_SECTIONS];

  const supplier = parties.find((p) => isSenderRole(p.role));
  const prompt = [
    'Склади інструкцію для постачальника (лист) українською у форматі Markdown.',
    'Контекст постачання:',
    `- Номер: ${ws.number}`,
    `- Категорія товару: ${ws.product_category}`,
    `- Країна походження: ${ws.origin_country}`,
    `- Умови поставки (вхідний Incoterms): ${ws.incoterm_in ?? ws.incoterm}`,
    `- Вид транспорту: ${ws.transport_mode}`,
    `- Постачальник: ${supplier?.company_name ?? ''}${supplier?.country ? `, ${supplier.country}` : ''}`,
    '',
    'Лист має чітко перелічити такі розділи:',
    ...chosen.map((s, i) => `${i + 1}) ${SECTION_TEXT[s]};`),
    'Пиши стисло, професійно, по пунктах.',
  ].join('\n');

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const instruction = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();

  const { id } = await saveArtifact(ws.id, 'supplier_instruction', instruction, 'md', 'agent');
  return { instruction, artifactId: id };
}
