import type { AnalysisCheck, AnalysisResult, AnalysisRow } from './run.js';

/**
 * Render an AnalysisResult as a conversational Markdown answer:
 *  - a header with the totals (in $ and, when the NBU rate is known, ₴), or a
 *    classification-only banner when the manifest carried no price/qty data,
 *  - a compact overview table across all products,
 *  - then, per product, TWO GFM tables — a "Зведена" key/value summary and a
 *    "Перевірки" list of the EU/UA broker checks (🔴/🟡/🟢).
 * Posted into the collection's conversation by the analyze route; `remark-gfm`
 * renders the tables in the chat.
 */

type Fx = AnalysisResult['fx'];

const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `${Math.round(n).toLocaleString('uk-UA')} $`;

/** Amount in $ plus its ≈ UAH equivalent when an NBU rate is available. */
function moneyFx(n: number | null | undefined, fx: Fx): string {
  const base = money(n);
  if (fx && n !== null && n !== undefined) {
    return `${base} (≈ ${Math.round(n * fx.rate).toLocaleString('uk-UA')} ₴)`;
  }
  return base;
}

/** Escape the `|` that would otherwise break a Markdown table cell. */
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function flagsLine(sc: AnalysisRow['sourceCheck']): string {
  if (!sc) return '—';
  const f: string[] = [];
  if (sc.banRf) f.push('🚫 заборона з РФ');
  if (sc.dualUse) f.push('⚠️ подвійне використання');
  if (sc.narcotic) f.push('⚠️ наркотичні/прекурсори');
  if (sc.license) f.push('ліцензування');
  if (sc.vetControl) f.push('ветконтроль');
  if (sc.phyto) f.push('фітоконтроль');
  return f.length ? f.join(', ') : '✓ без обмежень';
}

/** One-glyph qdpro summary for the overview table. */
function flagsShort(sc: AnalysisRow['sourceCheck']): string {
  if (!sc) return '—';
  if (sc.banRf) return '🚫';
  if (sc.narcotic || sc.dualUse) return '⚠️';
  if (sc.license || sc.vetControl || sc.phyto) return '📋';
  return '✓';
}

/** Duty rate for display — shows both the static table rate and qdpro's when they diverge. */
function rateDisplay(row: AnalysisRow): string {
  const stat = row.dutyRate != null ? `${row.dutyRate}%` : '—';
  const sc = row.sourceCheck;
  if (sc && sc.dutyMismatch && sc.dutyPref) return `${stat} таблиця · qdpro ${sc.dutyPref}`;
  return stat;
}

/** The clarifiers that change a substance's code/regime — shown when uncertain. */
function clarifyNote(row: AnalysisRow): string | null {
  const originUnknown = !row.origin || /unknown|mixed|невідом|змішан/i.test(row.origin);
  if (originUnknown || !row.code || row.codeSuggested || row.needsReview) {
    return 'форма (субстанція за замовч. — інакше уточнити) · призначення (pharma / food / feed / vet / cosmetic / industrial)';
  }
  return null;
}

function mark(status: string): string {
  return status === 'red' ? '🔴' : status === 'yellow' ? '🟡' : '🟢';
}

/** Compact overview across all products, for scanning a long manifest at a glance. */
function overviewTable(rows: AnalysisRow[]): string {
  const body = rows.map((r, i) => {
    const code = r.code ? (r.codeSuggested ? `${r.code}*` : r.code) : '—';
    const flag = r.needsReview ? `${flagsShort(r.sourceCheck)} ⚠️` : flagsShort(r.sourceCheck);
    return `| ${i + 1} | ${cell(truncate(r.name, 44))} | ${code} | ${flag} | ${r.risk ?? '—'} |`;
  });
  return [
    '| № | Товар | УКТ ЗЕД | qdpro | Ризик |',
    '|---|---|---|---|---|',
    ...body,
    '',
    '_\\* — код запропоновано автоматично, підтвердити; ⚠️ — потребує перевірки._',
  ].join('\n');
}

/** Second per-product table: one row per EU/UA check. */
function checksTable(eu: AnalysisCheck[] | undefined, ua: AnalysisCheck[] | undefined): string {
  const out: string[] = [];
  for (const c of eu ?? []) {
    out.push(`| 🇪🇺 Транзит ЄС | ${cell(c.item)}${c.note ? ` — ${cell(c.note)}` : ''} | ${mark(c.status)} |`);
  }
  for (const c of ua ?? []) {
    out.push(`| 🇺🇦 Розмитнення UA | ${cell(c.item)}${c.note ? ` — ${cell(c.note)}` : ''} | ${mark(c.status)} |`);
  }
  if (out.length === 0) return '_Перевірок за цим напрямом немає._';
  return ['| Напрям | Перевірка | Статус |', '|---|---|---|', ...out].join('\n');
}

function productBlock(row: AnalysisRow, i: number, costData: boolean, fx: Fx): string {
  let codeVal: string;
  if (row.code) {
    if (row.codeSuggested) {
      const verify =
        row.codeVerified === true
          ? ' ✓ перевірено qdpro'
          : row.codeVerified === false
            ? ' — не підтверджено qdpro'
            : '';
      const basis = row.codeBasis ? ` (${cell(truncate(row.codeBasis, 70))})` : '';
      codeVal = `${row.code} · _запропоновано, підтвердити_${verify}${basis}`;
    } else {
      codeVal = row.code;
    }
  } else {
    codeVal = '— · _код не визначено; підбір за описом/брокером_';
  }
  const originVal = row.origin ?? '—';
  const riskVal = row.risk ? `${row.risk}${row.riskNote ? ` — ${cell(row.riskNote)}` : ''}` : '—';
  const reviewBadge = row.needsReview ? '  ⚠️ потребує перевірки' : '';

  // Table 1 — key/value summary. The payments row is dropped in classification mode.
  const summaryRows = [
    `| **УКТ ЗЕД** | ${codeVal} |`,
    `| **Походження** | ${cell(originVal)} |`,
    `| **Ризик** | ${cell(riskVal)} |`,
  ];
  if (costData) {
    const rd = rateDisplay(row);
    const rateSuffix = rd === '—' ? '' : ` (${rd})`;
    summaryRows.push(
      `| **Платежі** | CIF ${moneyFx(row.cif, fx)} · мито ${moneyFx(row.duty, fx)}${rateSuffix} · ПДВ ${moneyFx(row.vat, fx)} |`,
    );
  }
  summaryRows.push(`| **qdpro (першоджерело)** | ${cell(flagsLine(row.sourceCheck))} |`);
  const clarify = clarifyNote(row);
  if (clarify) summaryRows.push(`| **Уточнити** | ${clarify} |`);
  const summary = [`| Параметр | Значення |`, `|---|---|`, ...summaryRows].join('\n');

  return [`### ${i + 1}. ${row.name}${reviewBadge}`, summary, checksTable(row.eu, row.ua)].join('\n\n');
}

export function formatAnalysisMarkdown(r: AnalysisResult): string {
  const t = r.totals;
  const costData = r.costDataAvailable;
  const fx = r.fx ?? null;
  const header: string[] = [`## Аналіз збірного вантажу — «${r.sheet}»`];
  if (costData) {
    header.push(
      `**Разом:** митна вартість (CIF) ${moneyFx(t.cif, fx)} · мито ${moneyFx(t.duty, fx)} · ПДВ ${moneyFx(t.vat, fx)} · **до сплати ${moneyFx(t.payable, fx)}** · позицій ${t.count}.`,
    );
    if (fx) header.push(`_Курс НБУ: 1 ${fx.currency} = ${fx.rate.toLocaleString('uk-UA')} ₴${fx.date ? ` (${fx.date})` : ''}._`);
  } else {
    header.push(
      `**Класифікаційний аналіз** — у маніфесті немає вартісних даних (ціна/кількість), тому платежі не розраховуються. Показано коди та перевірки. Позицій: ${t.count}.`,
    );
  }
  if (r.criticalAlert) header.push(`> ⚠️ ${r.criticalAlert}`);
  if (r.sourceChecked) header.push('_Коди, ставки та обмеження звірено з офіційним джерелом qdpro._');
  if (r.aiDegraded) header.push('_AI-перевірки були недоступні — показано детермінований розрахунок; позиції позначено «перевірити»._');

  const sections: string[] = [header.join('\n\n')];
  if (r.rows.length > 1) sections.push(`**Огляд позицій**\n\n${overviewTable(r.rows)}`);
  sections.push(...r.rows.map((row, i) => productBlock(row, i, costData, fx)));

  if (r.warnings && r.warnings.length > 0) {
    sections.push(['**Застереження:**', ...r.warnings.map((w) => `- ${w}`)].join('\n'));
  }
  sections.push('_Це попередній аналіз. Остаточну класифікацію та платежі підтверджує митний брокер._');

  return sections.join('\n\n');
}
