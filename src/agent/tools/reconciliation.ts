import { getWorkspaceById } from '../../shipments/workspaceAccess.js';
import { computeDiscrepancies } from '../../reconciliation/discrepancies.js';
import { computeRegistryChecks } from '../../customs/drugRegistry.js';
import { fieldLabel, computeRisks } from '../../reconciliation/risks.js';
import { refreshWorkspaceState } from '../../shipments/status.js';
import type { Citation } from '../../chat/conversations.js';
import { type ToolContext, type ToolOutcome, requireWorkspace } from './shared.js';

export async function runChecklist(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Чек-лист: помилка', citations: [] };
  const { checklist, status } = await refreshWorkspaceState(ws);
  if (checklist.length === 0) {
    return {
      result: 'Чек-лист порожній — не задано параметри постачання (категорія/інкотермс/транспорт).',
      summary: 'Чек-лист: порожньо',
      citations: [],
    };
  }
  const lines = checklist.map((i) => `- ${i.requirement_key}: ${statusUa(i.status)}`);
  return {
    result: `Статус постачання: ${status}\n${lines.join('\n')}`,
    summary: `Чек-лист: ${checklist.length} пунктів`,
    citations: [],
  };
}

function statusUa(s: string): string {
  return s === 'verified' ? 'підтверджено' : s === 'received' ? 'отримано' : 'бракує';
}

export async function runDiscrepancies(ctx: ToolContext): Promise<ToolOutcome> {
  const findings = await computeDiscrepancies(requireWorkspace(ctx));
  if (findings.length === 0) {
    return {
      result: 'Розбіжностей між контрактом / інвойсом / пакувальним листом не виявлено (за наявними даними).',
      summary: 'Розбіжності: 0',
      citations: [],
    };
  }
  const result = findings
    .map((f) => {
      const mark = f.kind === 'confirmed' ? '🔴' : '🟡';
      const srcs = f.citations
        .map((c) => (c.file_name ? `${c.doc_type}: «${c.file_name}» = ${c.value}` : `${c.doc_type} = ${c.value}`))
        .join('; ');
      const src = srcs ? ` (джерела: ${srcs})` : '';
      return `- ${mark} [${f.severity}] ${fieldLabel(f.field)} (${f.field}): очікується ${f.expected}; факт ${f.actual}${src}`;
    })
    .join('\n')
    .concat(
      '\n\nЛегенда: 🔴 підтверджено (обидва значення прочитано впевнено), 🟡 підозра — перевір ' +
        'у документі (read_file), перш ніж називати критичним. Рівень (error/warning/info) ' +
        'передавай як є — НЕ підвищуй його. Якщо прочитаний документ спростовує знахідку, ' +
        'скажи про це прямо.',
    );
  // Surface the source documents as citation chips (dedup by file name).
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const f of findings) {
    for (const c of f.citations) {
      if (c.file_name && !seen.has(c.file_name)) {
        seen.add(c.file_name);
        citations.push({ file: c.file_name, page: null });
      }
    }
  }
  const confirmed = findings.filter((f) => f.kind === 'confirmed').length;
  return {
    result,
    summary: `Розбіжності: ${findings.length} (🔴 ${confirmed})`,
    citations,
  };
}

export async function runRegistryCheck(ctx: ToolContext): Promise<ToolOutcome> {
  const findings = await computeRegistryChecks(requireWorkspace(ctx));
  if (findings.length === 0) {
    return {
      result:
        'Реєстраційних номерів у документах не знайдено, або зауважень за локальною базою ' +
        'Держреєстру ліків немає. Це довідкова перевірка — остаточне підтвердження за регуляторним фахівцем.',
      summary: 'Реєстр: 0 зауважень',
      citations: [],
    };
  }
  const result = findings
    .map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`)
    .join('\n');
  return {
    result: `Перевірка за Держреєстром ліків (довідково, підтверджує фахівець):\n${result}`,
    summary: `Реєстр: ${findings.length} зауважень`,
    citations: [],
  };
}

export async function runRisks(ctx: ToolContext): Promise<ToolOutcome> {
  const ws = await getWorkspaceById(requireWorkspace(ctx));
  if (!ws) return { result: 'Постачання не знайдено.', summary: 'Ризики: помилка', citations: [] };
  const risks = await computeRisks(ws);
  if (risks.length === 0) {
    return {
      result: 'Наразі ризиків не виявлено (за наявними даними).',
      summary: 'Ризики: 0',
      citations: [],
    };
  }
  const result = risks
    .map((r) => `- [${r.severity}] ${r.title}: ${r.detail}`)
    .join('\n');
  return { result, summary: `Ризики: ${risks.length}`, citations: [] };
}
