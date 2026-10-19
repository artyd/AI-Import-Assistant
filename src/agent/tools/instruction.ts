import { z } from 'zod';
import { getWorkspaceById } from '../../shipments/workspaceAccess.js';
import { buildSupplierInstruction } from '../../instruction/supplierInstruction.js';
import { listVersions, ensureDraftVersion, setProposals } from '../../instruction/store.js';
import { prefillDraft } from '../../instruction/prefill.js';
import { missingFields, REQUIRED_FIELDS, getPath, isProposablePath } from '../../instruction/types.js';
import { type ToolContext, type ToolOutcome, requireWorkspace } from './shared.js';

export async function runSupplierInstruction(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Інструкція: помилка', citations: [] };
  const res = await buildSupplierInstruction(ws);
  if ('missing' in res) {
    return {
      result: `Бракує даних для інструкції: ${res.missing.join(', ')}. Заповни їх у картці постачання.`,
      summary: 'Інструкція: бракує даних',
      citations: [],
    };
  }
  return { result: res.instruction, summary: 'Згенеровано інструкцію постачальнику', citations: [] };
}

export async function runGetInstructionDraft(ctx: ToolContext): Promise<ToolOutcome> {
  // Read-only: an unsaved shipment gets a prefill preview, nothing is written.
  const wsId = requireWorkspace(ctx);
  const [latest] = await listVersions(wsId);
  const v = latest ?? { version: 0, status: 'не збережено', draft: await prefillDraft((await getWorkspaceById(wsId))!) };
  const d = v.draft;
  const missing = missingFields(d);
  const fields = Object.keys(REQUIRED_FIELDS)
    .concat(['product.cas', 'product.hsCode', 'consignor.address', 'consignee.address', 'finalConsignee', 'terms.destination', 'terms.finalDestination', 'supplierEmail'])
    .map((p) => {
      // Quantity is stored as number + unit — show both, or "1" reads as unitless.
      const v = p === 'product.quantity' && d.product.quantity ? `${d.product.quantity} ${d.product.unit}` : (getPath(d, p) ?? '');
      return `${p} = ${JSON.stringify(v)}${d.sources[p] ? ` [${d.sources[p]}]` : ''}`;
    })
    .join('\n');
  const docs = d.docs.filter((x) => x.checked).map((x) => x.labelUk || x.label).join(', ');
  const result = [
    `Інструкція v${v.version} (${v.status}). Категорія: ${d.category}. Транспорт: ${d.terms.transport}. Consignee: ${d.consigneeChoice}.`,
    `Поля:\n${fields}`,
    `Документи в листі: ${docs}`,
    missing.length ? `НЕ заповнено: ${missing.map((m) => `${m.label} (${m.path})`).join(', ')}` : 'Усі обовʼязкові поля заповнені.',
    d.proposals.length ? `Вже запропоновано: ${d.proposals.map((p) => `${p.path}=${p.value}`).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { result, summary: `Інструкція v${v.version}: бракує ${missing.length}`, citations: [] };
}

export async function runProposeInstructionFields(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = z
    .object({
      fields: z
        .array(z.object({ path: z.string().max(64), value: z.string().trim().min(1).max(500), reason: z.string().max(300) }))
        .min(1)
        .max(20),
    })
    .safeParse(input);
  if (!parsed.success) return { result: 'Некоректні пропозиції.', summary: 'Інструкція: помилка', citations: [] };
  const wsId = requireWorkspace(ctx);
  const known = parsed.data.fields
    .filter((f) => isProposablePath(f.path))
    // Quantity and unit are separate fields — "1 kg" would print «1 kg kg».
    .map((f) =>
      f.path === 'product.quantity' ? { ...f, value: f.value.replace(/^\s*([\d.,\s]*\d)\s*[a-zа-яіїєґ.]+\s*$/i, '$1') } : f,
    );
  if (!known.length) return { result: 'Жодного дозволеного шляху поля — перевір назви.', summary: 'Інструкція: 0 пропозицій', citations: [] };
  const v = await ensureDraftVersion(wsId, async () => prefillDraft((await getWorkspaceById(wsId))!));
  const proposals = [...v.draft.proposals.filter((p) => !known.some((k) => k.path === p.path)), ...known].slice(-30);
  await setProposals(wsId, v.version, proposals);
  return {
    result: `Запропоновано ${known.length} знач. у конструкторі інструкції (v${v.version}) — користувач прийме або відхилить їх на екрані «Інструкція». Нічого не збережено автоматично.`,
    summary: `Інструкція: ${known.length} пропозицій`,
    citations: [],
  };
}
