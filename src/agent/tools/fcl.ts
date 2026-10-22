import { query } from '../../db/pool.js';
import { getWorkspaceById, type WorkspaceRow } from '../../shipments/workspaceAccess.js';
import { flattenFcl, loadFclVerdicts, type FclVerdicts, type LotVerdict } from '../../shipments/fclState.js';
import { fclFolderId, lotFolderId } from '../../shipments/lots.js';
import { shipmentChanged } from '../../shipments/state.js';
import { fieldLabel } from '../../reconciliation/risks.js';
import type { Discrepancy } from '../../reconciliation/discrepancies.js';
import type { Citation } from '../../chat/conversations.js';
import { type ToolContext, type ToolOutcome, requireWorkspace } from './shared.js';

/**
 * Штурман's tools for an FCL (Збірник, spec 006 #07). The shipment verdict tools
 * take an optional `lot`; without it they answer for the whole FCL. All verdicts
 * come from `loadFclVerdicts` — the agent never judges completeness by itself.
 */

const STATUS_UA: Record<string, string> = {
  draft: 'Чернетка',
  docs_in_progress: 'Документи в роботі',
  docs_complete: 'Документи повні',
  customs_ready: 'Готово до митниці',
  active: 'Активне',
  done: 'Готово',
};

function statusUa(s: string): string {
  return s === 'verified' ? 'підтверджено' : s === 'received' ? 'отримано' : 'бракує';
}

/** The FCL of the chat, or null for a plain shipment. */
export async function fclOf(ctx: ToolContext): Promise<WorkspaceRow | null> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  return ws && ws.kind === 'fcl' ? ws : null;
}

/** A lot by id or (part of) its name / supplier, case-insensitive. */
export function findLot(v: FclVerdicts, ref: string): LotVerdict | null {
  const r = ref.trim().toLowerCase();
  if (!r) return null;
  return (
    v.lots.find((l) => l.lot.id === ref.trim()) ??
    v.lots.find((l) => l.lot.name.toLowerCase() === r) ??
    v.lots.find((l) => l.lot.name.toLowerCase().includes(r) || l.lot.supplier_name.toLowerCase().includes(r)) ??
    null
  );
}

function lotRef(input: unknown): string {
  return String((input as { lot?: unknown })?.lot ?? '').trim();
}

function noLot(v: FclVerdicts, ref: string): ToolOutcome {
  return {
    result: `Партію «${ref}» не знайдено. Партії збірника: ${v.lots.map((l) => l.lot.name).join(', ') || 'немає'}.`,
    summary: 'Партію не знайдено',
    citations: [],
  };
}

function discrepancyLines(findings: (Discrepancy & { lot?: string })[]): { text: string; citations: Citation[] } {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  const text = findings
    .map((f) => {
      const mark = f.kind === 'confirmed' ? '🔴' : '🟡';
      const srcs = f.citations
        .map((c) => (c.file_name ? `${c.doc_type}: «${c.file_name}» = ${c.value}` : `${c.doc_type} = ${c.value}`))
        .join('; ');
      for (const c of f.citations) {
        if (c.file_name && !seen.has(c.file_name)) {
          seen.add(c.file_name);
          citations.push({ file: c.file_name, page: null });
        }
      }
      return `- ${mark} [${f.severity}]${f.lot ? ` ${f.lot}:` : ''} ${fieldLabel(f.field)}: очікується ${f.expected}; факт ${f.actual}${srcs ? ` (джерела: ${srcs})` : ''}`;
    })
    .join('\n');
  return { text, citations };
}

function lotLine(l: LotVerdict): string {
  const { checklist, discrepancies, risks } = l.verdicts;
  const done = checklist.filter((i) => i.status !== 'missing').length;
  const red = discrepancies.filter((d) => d.kind === 'confirmed').length;
  const yellow = discrepancies.length - red;
  const err = risks.filter((r) => r.severity === 'error').length;
  return (
    `- ${l.lot.name} (постачальник ${l.lot.supplier_name || '—'}; отримувач ${l.consignee ?? '—'}): ` +
    `${STATUS_UA[l.verdicts.derivedStatus] ?? l.verdicts.derivedStatus}, комплектність ${done}/${checklist.length}, ` +
    `розбіжності 🔴${red} 🟡${yellow}, критичні ризики ${err}, файлів ${l.fileCount}`
  );
}

/** get_checklist in an FCL: the FCL checklist + one line per lot, or one lot's checklist. */
export async function fclChecklist(ws: WorkspaceRow, input: unknown): Promise<ToolOutcome> {
  const v = await loadFclVerdicts(ws);
  const ref = lotRef(input);
  if (ref) {
    const lot = findLot(v, ref);
    if (!lot) return noLot(v, ref);
    const lines = lot.verdicts.checklist.map((i) => `- ${i.requirement_key}: ${statusUa(i.status)}`);
    return {
      result: `${lot.lot.name}: ${STATUS_UA[lot.verdicts.derivedStatus] ?? lot.verdicts.derivedStatus}\n${lines.join('\n') || '(вимог немає — не задано контекст партії)'}`,
      summary: `Чек-лист партії ${lot.lot.name}`,
      citations: [],
    };
  }
  const fcl = v.level.checklist.map((i) => `- ${i.label}: ${statusUa(i.status)}${i.stage === 'customs' ? ' (потрібно для «Готово до митниці»)' : ''}`);
  return {
    result:
      `Збірник №${ws.number}: ${STATUS_UA[v.level.derivedStatus] ?? v.level.derivedStatus} (за найгіршою партією).\n` +
      `Документи рівня FCL:\n${fcl.join('\n')}\n` +
      `Партії:\n${v.lots.map(lotLine).join('\n') || '- партій ще немає'}` +
      (v.level.unassigned > 0 ? `\nФайлів без партії: ${v.level.unassigned} (не враховуються в перевірках партій).` : ''),
    summary: `Чек-лист FCL: ${v.lots.length} партій`,
    citations: [],
  };
}

export async function fclDiscrepancies(ws: WorkspaceRow, input: unknown): Promise<ToolOutcome> {
  const v = await loadFclVerdicts(ws);
  const ref = lotRef(input);
  let findings: (Discrepancy & { lot?: string })[];
  let scope: string;
  if (ref) {
    const lot = findLot(v, ref);
    if (!lot) return noLot(v, ref);
    findings = lot.verdicts.discrepancies;
    scope = lot.lot.name;
  } else {
    findings = flattenFcl(v).discrepancies;
    scope = 'збірник';
  }
  if (findings.length === 0) {
    return { result: `Розбіжностей (${scope}) не виявлено за наявними даними.`, summary: 'Розбіжності: 0', citations: [] };
  }
  const { text, citations } = discrepancyLines(findings);
  return {
    result:
      `${text}\n\nЛегенда: 🔴 підтверджено (обидва значення прочитано впевнено), 🟡 підозра — перевір у документі ` +
      '(read_file). Рівень передавай як є — НЕ підвищуй його.',
    summary: `Розбіжності (${scope}): ${findings.length}`,
    citations,
  };
}

export async function fclRisks(ws: WorkspaceRow, input: unknown): Promise<ToolOutcome> {
  const v = await loadFclVerdicts(ws);
  const ref = lotRef(input);
  let risks;
  if (ref) {
    const lot = findLot(v, ref);
    if (!lot) return noLot(v, ref);
    risks = lot.verdicts.risks;
  } else {
    risks = flattenFcl(v).risks;
  }
  if (risks.length === 0) return { result: 'Ризиків не виявлено (за наявними даними).', summary: 'Ризики: 0', citations: [] };
  return {
    result: risks.map((r) => `- [${r.severity}] ${r.title}: ${r.detail}`).join('\n'),
    summary: `Ризики: ${risks.length}`,
    citations: [],
  };
}

export async function runListLots(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await fclOf(ctx);
  if (!ws) return { result: 'Партії є лише у збірнику.', summary: 'Партії: не збірник', citations: [] };
  const v = await loadFclVerdicts(ws);
  if (v.lots.length === 0) {
    return {
      result: 'Партій ще немає: вони створюються автоматично, коли прочитано інвойс, контракт або пакувальний лист нового постачальника.',
      summary: 'Партії: 0',
      citations: [],
    };
  }
  return {
    result: `${v.lots.map(lotLine).join('\n')}${v.level.unassigned > 0 ? `\nФайлів без партії: ${v.level.unassigned}.` : ''}`,
    summary: `Партії: ${v.lots.length}`,
    citations: [],
  };
}

export async function runGetFclOverview(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await fclOf(ctx);
  if (!ws) return { result: 'Зведена перевірка FCL доступна лише у збірнику.', summary: 'FCL: не збірник', citations: [] };
  const v = await loadFclVerdicts(ws);
  const lvl = v.level;
  const parts: string[] = [
    `Збірник №${ws.number}: ${STATUS_UA[lvl.derivedStatus] ?? lvl.derivedStatus} (рівень FCL: ${STATUS_UA[lvl.levelStatus] ?? lvl.levelStatus}).`,
    `Контейнер(и): ${lvl.containers.join(', ') || 'не прочитано'}. Транзит через ЄС: ${lvl.euTransit === null ? 'невідомо' : lvl.euTransit ? 'так' : 'ні'}.`,
    `Документи FCL:\n${lvl.checklist.map((i) => `- ${i.label}: ${statusUa(i.status)}`).join('\n')}`,
    `Отримувачі:\n${lvl.consignees.map((c) => `- ${c.name}: партії ${c.lots.join(', ')}; МД ${c.customs_declaration_file_id ? 'є' : 'немає'}`).join('\n') || '- не визначено (задайте отримувача FCL або партій)'}`,
  ];
  if (lvl.manifest) {
    const m = lvl.manifest;
    const bad = m.matches.filter((x) => x.status !== 'ok');
    parts.push(
      m.built
        ? `Маніфесту немає — позиції зібрано з інвойсів (${m.matches.length}).`
        : `Маніфест «${m.file_name}»: ${m.matches.length - bad.length} з ${m.matches.length} позицій збігаються з інвойсами.`,
    );
  } else {
    parts.push('Маніфест: немає даних.');
  }
  const { text, citations } = discrepancyLines(lvl.discrepancies);
  parts.push(lvl.discrepancies.length ? `Розбіжності FCL:\n${text}` : 'Розбіжностей рівня FCL не виявлено.');
  parts.push(`Партії:\n${v.lots.map(lotLine).join('\n') || '- немає'}`);
  if (lvl.unassigned > 0) parts.push(`Файлів без партії: ${lvl.unassigned}.`);
  return { result: parts.join('\n\n'), summary: `FCL: ${v.lots.length} партій`, citations };
}

export async function runAssignFileToLot(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await fclOf(ctx);
  if (!ws) return { result: 'Партії є лише у збірнику.', summary: 'Перенесення: не збірник', citations: [] };
  const fileRef = String((input as { file?: unknown })?.file ?? '').trim();
  const ref = lotRef(input);
  if (!fileRef || !ref) return { result: 'Вкажіть file (id або назву файлу) і lot (партію або «FCL»).', summary: 'Перенесення: помилка', citations: [] };

  const { rows } = await query<{ id: string; name: string; folder_id: string | null }>(
    `SELECT id, name, folder_id FROM files
     WHERE workspace_id = $1 AND is_latest = true AND (id::text = $2 OR name ILIKE '%' || $2 || '%')
     ORDER BY (id::text = $2) DESC, created_at LIMIT 2`,
    [ws.id, fileRef],
  );
  if (rows.length === 0) return { result: `Файл «${fileRef}» не знайдено.`, summary: 'Перенесення: файл не знайдено', citations: [] };
  if (rows.length > 1 && rows[0]!.id !== fileRef) {
    return { result: `Під «${fileRef}» підходить кілька файлів — уточніть назву.`, summary: 'Перенесення: неоднозначно', citations: [] };
  }
  const file = rows[0]!;

  let folderId: string | null;
  let target: string;
  const fclRole = /^(fcl|транспорт)/i.test(ref) ? 'transport' : /митниц/i.test(ref) ? 'customs' : /маніфест|manifest/i.test(ref) ? 'manifest' : null;
  if (/^(inbox|інбокс)$/i.test(ref)) {
    folderId = null;
    target = 'Інбокс';
  } else if (fclRole) {
    folderId = await fclFolderId(ws.id, fclRole);
    target = `папка FCL (${fclRole})`;
  } else {
    const lot = findLot(await loadFclVerdicts(ws), ref);
    if (!lot) return noLot(await loadFclVerdicts(ws), ref);
    folderId = await lotFolderId(lot.lot.id);
    target = lot.lot.name;
  }
  await query(
    `UPDATE files SET folder_id = $1, suggested_folder_id = NULL, folder_reason = 'перенесено Штурманом за проханням користувача'
     WHERE id = $2 AND workspace_id = $3`,
    [folderId, file.id, ws.id],
  );
  await shipmentChanged(ws.id, 'files');
  return { result: `Файл «${file.name}» перенесено: ${target}.`, summary: `Перенесено: ${file.name} → ${target}`, citations: [] };
}
