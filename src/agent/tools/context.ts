import { z } from 'zod';
import { query } from '../../db/pool.js';
import { insertNotification } from '../../notifications/notifications.js';
import { getWorkspaceById } from '../../shipments/workspaceAccess.js';
import { realignPartiesForMode, proposePartyFieldsForMode } from '../../instruction/realign.js';
import { refreshWorkspaceState } from '../../shipments/status.js';
import { getMissingContext, upsertParties, type PartyInput } from '../../reconciliation/parties.js';
import { analyzeParties } from '../../reconciliation/partyExtraction.js';
import { stampManualEdit, changedFields } from '../../shipments/autoContext.js';
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
  const sets: string[] = [];
  const vals: unknown[] = [ws.id];
  for (const key of scalarKeys) {
    const value = parsed.data[key];
    if (value === undefined) continue;
    sets.push(`${key} = $${vals.length + 1}`);
    vals.push(value);
  }
  // A contract_type gathered from the user in conversation is a human-confirmed
  // value → stamp provenance so auto-detection (set_contract_mode source="auto")
  // won't overwrite it. The dedicated set_contract_mode tool is preferred for the
  // mode; this keeps the invariant when the agent bundles it into intake context.
  if (parsed.data.contract_type !== undefined) {
    sets.push(`contract_type_source = $${vals.length + 1}`);
    vals.push('survey');
    sets.push(`contract_type_confidence = $${vals.length + 1}`);
    vals.push(null);
    sets.push(`contract_type_reason = $${vals.length + 1}`);
    vals.push('Зібрано в розмові з користувачем.');
  }
  // Context the user gave in conversation is a manual value — the document
  // autopilot must not overwrite it later.
  stampManualEdit(changedFields(ws, parsed.data), sets, vals);
  if (sets.length > 0) {
    await query(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = $1`, vals);
  }
  if (parsed.data.incoterm_in !== undefined) {
    await query('UPDATE workspaces SET incoterm = incoterm_in WHERE id = $1', [ws.id]);
  }
  if (parsed.data.parties) {
    await upsertParties(ws.id, parsed.data.parties as PartyInput[]);
  }

  // Recompute intake_complete and refresh derived state.
  await refreshAfterWorkspaceWrite(ws.id);
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

async function refreshAfterWorkspaceWrite(wsId: string): Promise<void> {
  const merged = (await getWorkspaceById(wsId))!;
  const complete = Boolean(
    merged.contract_type &&
      merged.product_category &&
      (merged.incoterm_in ?? merged.incoterm) &&
      merged.transport_mode &&
      merged.origin_country,
  );
  if (complete !== merged.intake_complete) {
    await query('UPDATE workspaces SET intake_complete = $2 WHERE id = $1', [wsId, complete]);
  }
  const finalWs = (await getWorkspaceById(wsId))!;
  if (finalWs.intake_complete) await refreshWorkspaceState(finalWs);
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
    await refreshAfterWorkspaceWrite(wsId);
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
  await refreshAfterWorkspaceWrite(wsId);
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
