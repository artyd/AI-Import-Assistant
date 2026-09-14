import * as XLSX from 'xlsx';
import type { AnalysisResult } from '../pipeline/deterministic.js';
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
