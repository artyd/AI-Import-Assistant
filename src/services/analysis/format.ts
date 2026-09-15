import type { AnalysisCheck, AnalysisResult, AnalysisRow } from './run.js';

/**
 * Render an AnalysisResult as a conversational Markdown answer — a short summary
 * followed by ONE block per product — so the consolidated analysis reads like a
 * normal chat reply instead of a raw table. Posted into the collection's
 * conversation by the analyze route.
 */

const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `${Math.round(n).toLocaleString('uk-UA')} $`;

function flagsLine(sc: AnalysisRow['sourceCheck']): string {
  if (!sc) return '—';
  const f: string[] = [];
  if (sc.banRf) f.push('🚫 заборона з РФ');
  if (sc.dualUse) f.push('⚠️ подвійне використання');
  if (sc.narcotic) f.push('⚠️ наркотичні/прекурсори');
  if (sc.license) f.push('ліцензування');
  if (sc.vetControl) f.push('ветконтроль');
  if (sc.phyto) f.push('фітоконтроль');
  if (sc.dutyMismatch && sc.dutyPref) f.push(`ставка qdpro ${sc.dutyPref}`);
  return f.length ? f.join(', ') : '✓ без обмежень';
}

function checksLine(list: AnalysisCheck[] | undefined): string {
  if (!list || list.length === 0) return '—';
  return list
    .map((c) => {
      const mark = c.status === 'red' ? '🔴' : c.status === 'yellow' ? '🟡' : '🟢';
      return `${mark} ${c.item}${c.note ? ` — ${c.note}` : ''}`;
    })
    .join('; ');
}

function productBlock(row: AnalysisRow, i: number): string {
  const review = row.needsReview ? '  ·  ⚠️ потребує перевірки' : '';
  const rate = row.dutyRate != null ? ` (${row.dutyRate}%)` : '';
  const risk = row.risk ? `  ·  **ризик:** ${row.risk}` : '';
  const riskNote = row.riskNote ? ` — ${row.riskNote}` : '';
  return [
    `### ${i + 1}. ${row.name}`,
    `- **УКТ ЗЕД:** ${row.code ?? '—'}${review}`,
    `- **Платежі:** CIF ${money(row.cif)} · мито ${money(row.duty)}${rate} · ПДВ ${money(row.vat)}`,
    `- **Походження:** ${row.origin ?? '—'}${risk}${riskNote}`,
    `- **qdpro (першоджерело):** ${flagsLine(row.sourceCheck)}`,
    `- **Транзит ЄС:** ${checksLine(row.eu)}`,
    `- **Розмитнення UA:** ${checksLine(row.ua)}`,
  ].join('\n');
}

export function formatAnalysisMarkdown(r: AnalysisResult): string {
  const t = r.totals;
  const header: string[] = [
    `## Аналіз збірного вантажу — «${r.sheet}»`,
    `**Разом:** митна вартість (CIF) ${money(t.cif)} · мито ${money(t.duty)} · ПДВ ${money(t.vat)} · **до сплати ${money(t.payable)}** · позицій ${t.count}.`,
  ];
  if (r.criticalAlert) header.push(`> ⚠️ ${r.criticalAlert}`);
  if (r.sourceChecked) header.push('_Коди, ставки та обмеження звірено з офіційним джерелом qdpro._');
  if (r.aiDegraded) header.push('_AI-перевірки були недоступні — показано детермінований розрахунок; позиції позначено «перевірити»._');

  const sections: string[] = [header.join('\n\n'), ...r.rows.map(productBlock)];

  if (r.warnings && r.warnings.length > 0) {
    sections.push(['**Застереження:**', ...r.warnings.map((w) => `- ${w}`)].join('\n'));
  }
  sections.push('_Це попередній аналіз. Остаточну класифікацію та платежі підтверджує митний брокер._');

  return sections.join('\n\n');
}
