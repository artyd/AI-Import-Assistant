import { z } from 'zod';
import { getWorkspaceById } from '../../shipments/workspaceAccess.js';
import { buildSupplierInstruction } from '../../instruction/supplierInstruction.js';
import { listVersions, ensureDraftVersion, setProposals } from '../../instruction/store.js';
import { prefillDraft } from '../../instruction/prefill.js';
import { missingFields, REQUIRED_FIELDS, getPath, isProposablePath } from '../../instruction/types.js';
import { type ToolContext, type ToolOutcome, requireWorkspace } from './shared.js';
import type { WorkspaceRow } from '../../shipments/workspaceAccess.js';
import { loadFclVerdicts, lotWorkspaceView } from '../../shipments/fclState.js';
import { findLot } from './fcl.js';

interface InstructionScope {
  ws: WorkspaceRow;
  view: WorkspaceRow;
  lotId: string | null;
}

/**
 * A shipment's instruction, or in an FCL (spec 006) one lot's: the letter goes to
 * ONE supplier, so an FCL needs `lot`. Returns an outcome to send back on a miss.
 */
async function instructionScope(ctx: ToolContext, input: unknown): Promise<InstructionScope | ToolOutcome> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Інструкція: помилка', citations: [] };
  if (ws.kind !== 'fcl') return { ws, view: ws, lotId: null };
  const ref = String((input as { lot?: unknown })?.lot ?? '').trim();
  const v = await loadFclVerdicts(ws);
  const lot = ref ? findLot(v, ref) : null;
  if (!lot) {
    return {
      result: `У збірнику інструкція складається для однієї партії (одного постачальника): вкажи lot. Партії: ${v.lots.map((l) => l.lot.name).join(', ') || 'немає'}.`,
      summary: 'Інструкція: потрібна партія',
      citations: [],
    };
  }
  return { ws, view: lotWorkspaceView(ws, lot.lot), lotId: lot.lot.id };
}

function isOutcome(x: InstructionScope | ToolOutcome): x is ToolOutcome {
  return 'result' in x;
}

export async function runSupplierInstruction(ctx: ToolContext, input: unknown = {}): Promise<ToolOutcome> {
  const scope = await instructionScope(ctx, input);
  if (isOutcome(scope)) return scope;
  const res = await buildSupplierInstruction(scope.ws, scope);
  if ('missing' in res) {
    return {
      result: `Бракує даних для інструкції: ${res.missing.join(', ')}. Заповни їх у картці постачання.`,
      summary: 'Інструкція: бракує даних',
      citations: [],
    };
  }
  return { result: res.instruction, summary: 'Згенеровано інструкцію постачальнику', citations: [] };
}

export async function runGetInstructionDraft(ctx: ToolContext, input: unknown = {}): Promise<ToolOutcome> {
  // Read-only: an unsaved shipment gets a prefill preview, nothing is written.
  const scope = await instructionScope(ctx, input);
  if (isOutcome(scope)) return scope;
  const [latest] = await listVersions(scope.ws.id, scope.lotId);
  const v = latest ?? { version: 0, status: 'не збережено', draft: await prefillDraft(scope.view, null, { lotId: scope.lotId ?? undefined }) };
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
  const scope = await instructionScope(ctx, input);
  if (isOutcome(scope)) return scope;
  const wsId = scope.ws.id;
  const known = parsed.data.fields
    .filter((f) => isProposablePath(f.path))
    // Quantity and unit are separate fields — "1 kg" would print «1 kg kg».
    .map((f) =>
      f.path === 'product.quantity' ? { ...f, value: f.value.replace(/^\s*([\d.,\s]*\d)\s*[a-zа-яіїєґ.]+\s*$/i, '$1') } : f,
    );
  if (!known.length) return { result: 'Жодного дозволеного шляху поля — перевір назви.', summary: 'Інструкція: 0 пропозицій', citations: [] };
  const v = await ensureDraftVersion(wsId, async () => prefillDraft(scope.view, null, { lotId: scope.lotId ?? undefined }), scope.lotId);
  const proposals = [...v.draft.proposals.filter((p) => !known.some((k) => k.path === p.path)), ...known].slice(-30);
  await setProposals(wsId, v.version, proposals);
  return {
    result: `Запропоновано ${known.length} знач. у конструкторі інструкції (v${v.version}) — користувач прийме або відхилить їх на екрані «Інструкція». Нічого не збережено автоматично.`,
    summary: `Інструкція: ${known.length} пропозицій`,
    citations: [],
  };
}
