import { z } from 'zod';
import { query } from '../../db/pool.js';
import { insertNotification } from '../../notifications/notifications.js';
import { getWorkspaceById } from '../../shipments/workspaceAccess.js';
import { realignPartiesForMode, proposePartyFieldsForMode } from '../../instruction/realign.js';
import { shipmentChanged } from '../../shipments/state.js';
import { getMissingContext, upsertParties, type PartyInput } from '../../reconciliation/parties.js';
import { analyzeParties } from '../../reconciliation/partyExtraction.js';
import { writeManualContext } from '../../shipments/autoContext.js';
import { type ToolContext, type ToolOutcome, requireWorkspace } from './shared.js';

export async function runMissingContext(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Контекст: помилка', citations: [] };
  const missing = await getMissingContext(ws);
  if (missing.length === 0) {
    return { result: 'Усі параметри постачання задані.', summary: 'Контекст: повний', citations: [] };
  }
  return {
    result: `Не задано: ${missing.join(', ')}.`,
    summary: `Бракує параметрів: ${missing.length}`,
    citations: [],
  };
}

const saveContextSchema = z.object({
  contract_type: z.enum(['bilateral', 'trilateral']).optional(),
  product_category: z.string().optional(),
  incoterm: z.string().optional(),
  incoterm_in: z.string().optional(),
  incoterm_out: z.string().optional(),
  transport_mode: z.string().optional(),
  origin_country: z.string().optional(),
  destination_country: z.string().optional(),
  parties: z
    .array(
      z.object({
        role: z.string().min(1),
        company_name: z.string().min(1),
        is_internal: z.boolean().optional(),
        country: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

export async function runSaveContext(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = saveContextSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { result: 'Некоректні дані для збереження контексту.', summary: 'Контекст: помилка', citations: [] };
  }
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Контекст: помилка', citations: [] };

  const scalarKeys = [
    'contract_type',
    'product_category',
    'incoterm',
    'incoterm_in',
    'incoterm_out',
    'transport_mode',
    'origin_country',
    'destination_country',
  ] as const;
  // Context the user gave in conversation is a manual value: a contract_type is
  // locked against auto-detection (set_contract_mode source="auto") and the
  // document autopilot must not overwrite the fields later.
  const columns = Object.fromEntries(scalarKeys.map((k) => [k, parsed.data[k]]));
  await writeManualContext(ws, columns, { by: 'survey', reason: 'Зібрано в розмові з користувачем.' });
  if (parsed.data.parties) {
    await upsertParties(ws.id, parsed.data.parties as PartyInput[]);
  }

  await shipmentChanged(ws.id, 'context');
  const changed = [
    ...scalarKeys.filter((k) => parsed.data[k] !== undefined),
    ...(parsed.data.parties ? ['parties'] : []),
  ];
  if (changed.length) await notifyAgentContextChange(ws.id, changed.join(', '));
  const finalWs = (await getWorkspaceById(ws.id))!;
  const missing = await getMissingContext(finalWs);
  return {
    result:
      'Контекст збережено.' +
      (missing.length ? ` Ще бракує: ${missing.join(', ')}.` : ' Усі параметри задані.'),
    summary: 'Збережено контекст постачання',
    citations: [],
  };
}

/**
 * Provenance for agent-made context changes: the responsible user gets an in-app
 * notification, so a change the agent was talked into (e.g. by text inside an
 * uploaded document) is visible and can be reverted in the sidebar.
 */
async function notifyAgentContextChange(wsId: string, what: string): Promise<void> {
  const ws = await getWorkspaceById(wsId);
  if (!ws?.responsible_user_id) return;
  await insertNotification(
    ws.responsible_user_id,
    wsId,
    'agent_context_change',
    `Постачання №${ws.number}: Штурман змінив контекст — ${what}. Перевірте на панелі.`,
  ).catch(() => undefined);
}

// Ukrainian labels for the two contract structures, used in tool output.
const CONTRACT_MODE_UK: Record<'bilateral' | 'trilateral', string> = {
  bilateral: 'двосторонній (2 сторони: постачальник → імпортер)',
  trilateral: 'тристоронній (3 сторони: постачальник → посередник → імпортер)',
};

export async function runGetContractMode(ctx: ToolContext): Promise<ToolOutcome> {
  const wsId = requireWorkspace(ctx);
  const ws = await getWorkspaceById(wsId);
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Режим: помилка', citations: [] };

  const analysis = await analyzeParties(wsId);
  const manual = ws.contract_type_source === 'sidebar' || ws.contract_type_source === 'survey';

  const storedLine = ws.contract_type
    ? `Збережено: ${CONTRACT_MODE_UK[ws.contract_type]} — джерело: ${
        manual
          ? 'встановлено вручну (не перезаписувати автоматично)'
          : ws.contract_type_source === 'auto'
            ? 'автовизначено'
            : 'невідоме'
      }.`
    : 'Збережено: режим ще не задано.';

  const autoLine = analysis.contract_type
    ? `За документами: ${CONTRACT_MODE_UK[analysis.contract_type]} — впевненість ${Math.round(
        analysis.contract_type_confidence * 100,
      )}%. ${analysis.contract_type_reason}`
    : `За документами визначити не вдалося: ${analysis.contract_type_reason}`;

  const hint = manual
    ? 'Значення встановлене вручну — set_contract_mode source="auto" його не змінить. Щоб ' +
      'змінити, потрібне підтвердження користувача (source="survey").'
    : analysis.contract_type
      ? 'Щоб зафіксувати авто-висновок, виклич set_contract_mode source="auto".'
      : 'Даних недостатньо — уточни в користувача або запусти опитування.';

  return {
    result: `${storedLine}\n${autoLine}\n${hint}`,
    summary: `Режим: ${ws.contract_type ?? 'не задано'}`,
    citations: [],
  };
}

const setContractModeSchema = z.object({
  source: z.enum(['auto', 'survey']),
  contract_type: z.enum(['bilateral', 'trilateral']).optional(),
});

export async function runSetContractMode(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = setContractModeSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { result: 'Некоректні дані для set_contract_mode.', summary: 'Режим: помилка', citations: [] };
  }
  const wsId = requireWorkspace(ctx);
  const ws = await getWorkspaceById(wsId);
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Режим: помилка', citations: [] };

  if (parsed.data.source === 'auto') {
    // Auto path re-derives the verdict deterministically — the model's
    // contract_type is ignored to prevent persisting a hallucinated mode.
    const analysis = await analyzeParties(wsId);
    if (!analysis.contract_type) {
      return {
        result: `Автовизначення неможливе: ${analysis.contract_type_reason} Уточни в користувача або запусти опитування.`,
        summary: 'Режим: не визначено',
        citations: [],
      };
    }
    // Honor the manual-override lock — never overwrite a human-set value.
    if (ws.contract_type_source === 'sidebar' || ws.contract_type_source === 'survey') {
      return {
        result:
          `Режим уже встановлено вручну (${ws.contract_type ? CONTRACT_MODE_UK[ws.contract_type] : '—'}). ` +
          'Автовизначення не перезаписує ручне значення. За документами: ' +
          `${CONTRACT_MODE_UK[analysis.contract_type]} (впевненість ${Math.round(
            analysis.contract_type_confidence * 100,
          )}%).`,
        summary: 'Режим: залишено ручне значення',
        citations: [],
      };
    }
    await query(
      `UPDATE workspaces SET contract_type = $2, contract_type_source = 'auto',
         contract_type_confidence = $3, contract_type_reason = $4 WHERE id = $1`,
      [wsId, analysis.contract_type, analysis.contract_type_confidence, analysis.contract_type_reason],
    );
    await shipmentChanged(wsId, 'context');
    return {
      result:
        `Збережено режим (авто): ${CONTRACT_MODE_UK[analysis.contract_type]}, впевненість ` +
        `${Math.round(analysis.contract_type_confidence * 100)}%. ${analysis.contract_type_reason}`,
      summary: `Режим (авто): ${analysis.contract_type}`,
      citations: [],
    };
  }

  // source === 'survey' — user-confirmed; wins over any prior value (incl. auto/manual).
  const ct = parsed.data.contract_type;
  if (!ct) {
    return {
      result: 'Для source="survey" вкажи contract_type (bilateral|trilateral) — те, що підтвердив користувач.',
      summary: 'Режим: бракує contract_type',
      citations: [],
    };
  }
  await query(
    `UPDATE workspaces SET contract_type = $2, contract_type_source = 'survey',
       contract_type_confidence = NULL, contract_type_reason = $3 WHERE id = $1`,
    [wsId, ct, 'Підтверджено користувачем у розмові.'],
  );
  // Keep the parties card and the open instruction draft in line with the mode,
  // so the user doesn't have to retype the consignor/consignee by hand.
  const partiesNote = await realignPartiesForMode(wsId, ct);
  const proposed = await proposePartyFieldsForMode(wsId, ct);
  await shipmentChanged(wsId, 'context');
  await notifyAgentContextChange(wsId, `режим контракту → ${CONTRACT_MODE_UK[ct]}`);
  return {
    result:
      `Збережено режим (підтверджено користувачем): ${CONTRACT_MODE_UK[ct]}.` +
      (partiesNote ? ` ${partiesNote}` : '') +
      (proposed > 0
        ? ` У конструкторі інструкції запропоновано ${proposed} виправлень відправника/одержувача — ` +
          'користувач приймає їх на екрані «Інструкція» (перемикач Consignee вже виставлено).'
        : ''),
    summary: `Режим (survey): ${ct}`,
    citations: [],
  };
}
