import * as XLSX from 'xlsx';
import type { AnalysisResult } from '../pipeline/deterministic.js';
import type { AnalysisResult as ConsolidatedAnalysis } from '../run.js';
import type { AiResponse } from '../types/aiSchema.js';

/**
 * Будує XLSX-звіт за результатом детермінованого аналізу.
 *
 * NOTE(B-1): порт браузерного exportReport на серверний бік. Замість
 * Blob/URL.createObjectURL/`a.click()` (DOM) повертаємо Buffer — маршрут B-2
 * віддасть його як attachment. Логіка побудови листів збережена 1:1. Блок
 * перевірок (Перевірки ЄС / Розмитнення UA) додається лише коли передано `ai`
 * (заповнюється в B-2); за `ai === null` виходять два детермінованих листи.
 */
export function buildReportXlsx(r: AnalysisResult, currency: string, ai: AiResponse | null): Buffer {
  const wb = XLSX.utils.book_new();
  const s = r.calc.summary;

  const summary: (string | number)[][] = [
    ['LOGI-ANALYZER PRO — звіт'],
    ['Лист', r.selectedSheetName],
    ['Дата листа', r.selectedSheetDate ?? '—'],
    ['Причина вибору', r.reason],
    ['Валюта', currency],
    [],
    ['Митна вартість', s.totalCustomsValue.value],
    ['Мито', s.totalDuty.value],
    ['ПДВ', s.totalVAT.value],
    ['До сплати', s.totalPayable.value],
    ['Є оцінки (~)', s.anyEstimated ? 'так' : 'ні'],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(summary);
  ws1['!cols'] = [{ wch: 22 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Зведена');

  const head = ['Товар', 'УКТЗЕД', 'К-сть, кг', 'Ціна', 'Митна варт.', 'Ставка %', 'Мито', 'ПДВ', 'Разом', 'Оцінка', 'Прекурсор', 'ADR', 'Походження'];
  const rows = r.lines.map((l) => [
    l.calc.name,
    l.resolved.code.value ?? '',
    l.calc.qtyKg,
    +(l.calc.goodsValue.value / (l.calc.qtyKg || 1)).toFixed(2),
    l.calc.customsValue.value,
    l.calc.dutyRatePercent?.value ?? '',
    l.calc.duty?.value ?? '',
    l.calc.vat?.value ?? '',
    l.calc.totalPayable?.value ?? '',
    l.calc.customsValue.estimated ? 'так' : '',
    l.resolved.precursor ? `Табл.${l.resolved.precursor.table}` : '',
    l.resolved.adr?.class ?? '',
    l.resolved.origin?.originType ?? '',
  ]);
  const ws2 = XLSX.utils.aoa_to_sheet([head, ...rows]);
  ws2['!cols'] = head.map((h) => ({ wch: Math.max(10, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws2, 'Детальний');

  if (ai) {
    const eu: string[][] = [['Товар', 'Перевірка', 'Статус', 'Коментар']];
    const ua: string[][] = [['Товар', 'Перевірка', 'Статус', 'Коментар']];
    for (const it of ai.items) {
      for (const c of it.euChecks) eu.push([it.name, c.item, c.status, c.note]);
      for (const c of it.uaChecks) ua.push([it.name, c.item, c.status, c.note]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(eu), 'Перевірки ЄС');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ua), 'Розмитнення UA');
  }

  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
}

/**
 * Builds the .xlsx report from the persisted B-2 consolidated `AnalysisResult`
 * (run.ts shape). Used by `GET /api/analyses/:id/xlsx` to rebuild the export from
 * the stored analysis without re-running the engine. Mirrors buildReportXlsx's
 * sheet layout (Зведена / Детальний / Перевірки ЄС / Розмитнення UA).
 */
export function buildConsolidatedReportXlsx(r: ConsolidatedAnalysis): Buffer {
  const wb = XLSX.utils.book_new();

  const summary: (string | number)[][] = [
    ['LOGI-ANALYZER PRO — звіт'],
    ['Джерело', r.source],
    ['Лист', r.meta.sheet],
    ['Дата листа', r.meta.date ?? '—'],
    ['Причина вибору', r.meta.reason],
    [],
    ['Митна вартість', r.totals.cif],
    ['Мито', r.totals.duty],
    ['ПДВ', r.totals.vat],
    ['До сплати', r.totals.payable],
    ['Позицій', r.totals.count],
  ];
  if (r.fx && r.fx.rate > 0) {
    const rate = r.fx.rate;
    summary.push(
      [],
      [`Курс НБУ (1 ${r.fx.currency})`, `${rate} ₴${r.fx.date ? ` (${r.fx.date})` : ''}`],
      ['Митна вартість, ₴', Math.round(r.totals.cif * rate)],
      ['Мито, ₴', Math.round(r.totals.duty * rate)],
      ['ПДВ, ₴', Math.round(r.totals.vat * rate)],
      ['До сплати, ₴', Math.round(r.totals.payable * rate)],
    );
  }
  if (!r.costDataAvailable) {
    summary.push([], ['Класифікаційний аналіз', 'У маніфесті немає вартісних даних — платежі не розраховано.']);
  }
  if (r.criticalAlert) summary.push([], ['Критичний фактор', r.criticalAlert]);
  const ws1 = XLSX.utils.aoa_to_sheet(summary);
  ws1['!cols'] = [{ wch: 22 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Зведена');

  const head = ['Товар', 'УКТЗЕД', 'К-сть, кг', 'Ціна', 'Митна варт.', 'Ставка %', 'Мито', 'ПДВ', 'Походження', 'Категорія', 'Ризик', 'Перевірити'];
  const rows = r.rows.map((l) => [
    l.name,
    l.code
      ? l.codeSuggested
        ? `${l.code} (запропоновано${l.codeVerified === true ? ', ✓ qdpro' : l.codeVerified === false ? ', не підтв.' : ''})`
        : l.code
      : '',
    l.qtyKg,
    l.price,
    l.cif,
    l.dutyRate ?? '',
    l.duty ?? '',
    l.vat ?? '',
    l.origin ?? '',
    l.category ?? '',
    l.risk ?? '',
    l.needsReview ? 'так' : '',
  ]);
  const ws2 = XLSX.utils.aoa_to_sheet([head, ...rows]);
  ws2['!cols'] = head.map((h) => ({ wch: Math.max(10, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws2, 'Детальний');

  const eu: string[][] = [['Товар', 'Перевірка', 'Статус', 'Коментар']];
  const ua: string[][] = [['Товар', 'Перевірка', 'Статус', 'Коментар']];
  for (const l of r.rows) {
    for (const c of l.eu) eu.push([l.name, c.item, c.status, c.note]);
    for (const c of l.ua) ua.push([l.name, c.item, c.status, c.note]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(eu), 'Транзит через ЄС');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ua), 'Імпорт в Україну');

  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
}
