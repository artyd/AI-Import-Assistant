import { anthropic, MODEL } from '../anthropic/client.js';
import { query } from '../db/pool.js';
import type { WorkspaceRow } from './workspaceAccess.js';
import { saveArtifact } from './artifacts.js';

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
  if (!ws.incoterm) missing.push('incoterm');
  if (!ws.transport_mode) missing.push('transport_mode');
  if (!parties.some((p) => p.role === 'supplier')) missing.push('supplier_party');
  return missing;
}

export async function buildSupplierInstruction(
  ws: WorkspaceRow,
): Promise<InstructionResult | MissingContext> {
  const { rows: parties } = await query<PartyRow>(
    'SELECT role, company_name, country FROM parties WHERE workspace_id = $1',
    [ws.id],
  );

  const missing = requiredMissing(ws, parties);
  if (missing.length > 0) return { missing };

  const supplier = parties.find((p) => p.role === 'supplier');
  const prompt = [
    'Склади інструкцію для постачальника (лист) українською у форматі Markdown.',
    'Контекст постачання:',
    `- Номер: ${ws.number}`,
    `- Категорія товару: ${ws.product_category}`,
    `- Країна походження: ${ws.origin_country}`,
    `- Умови поставки (Incoterms): ${ws.incoterm}`,
    `- Вид транспорту: ${ws.transport_mode}`,
    `- Постачальник: ${supplier?.company_name ?? ''}${supplier?.country ? `, ${supplier.country}` : ''}`,
    '',
    'Лист має чітко перелічити: 1) перелік обовʼязкових документів (інвойс, пакувальний',
    'лист, PO, сертифікат походження, сертифікати якості, транспортні документи);',
    '2) вимоги до інвойсу та пакувального листа (реквізити, відповідність сум і ваги);',
    '3) вимоги до маркування, палет, фото; 4) вимоги до сертифікатів; 5) орієнтовні',
    'терміни надання. Пиши стисло, професійно, по пунктах.',
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
