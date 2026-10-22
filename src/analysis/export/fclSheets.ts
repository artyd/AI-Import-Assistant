import * as XLSX from 'xlsx';
import type { FclVerdicts } from '../../shipments/fclState.js';
import { flattenFcl } from '../../shipments/fclState.js';
import { fieldLabel } from '../../reconciliation/risks.js';

/**
 * The reconciliation sheets of a Збірник (FCL, spec 006 #08), appended to the
 * consolidated analysis workbook: manifest ↔ invoices, every discrepancy (FCL and
 * lots), and risks by lot. Works on any xlsx buffer — the Python-styled report or
 * the built-in one.
 */

const MATCH_UA: Record<string, string> = {
  ok: 'збігається',
  qty: 'розбіжність кг',
  price: 'розбіжність ціни',
  no_invoice: 'немає інвойсу',
  not_in_manifest: 'поза маніфестом',
};

export function fclSheetRows(v: FclVerdicts): Record<string, (string | number)[][]> {
  const manifest: (string | number)[][] = [
    ['Позиція маніфесту', 'Кг (маніфест)', 'Ціна (маніфест)', 'Партія', 'Позиція інвойсу', 'Кг (інвойс)', 'Ціна (інвойс)', 'Інвойс', 'Результат'],
  ];
  for (const m of v.level.manifest?.matches ?? []) {
    manifest.push([
      m.manifest?.name ?? '',
      m.manifest?.qtyKg ?? '',
      m.manifest?.unitPrice ?? '',
      m.invoice?.lot_name ?? '',
      m.invoice?.description ?? '',
      m.invoice?.qty_kg ?? '',
      m.invoice?.unit_price ?? '',
      m.invoice?.file_name ?? '',
      MATCH_UA[m.status] ?? m.status,
    ]);
  }
  if (v.level.manifest?.built) manifest.unshift(['Маніфесту немає — позиції зібрано з інвойсів партій.']);

  const { discrepancies, risks } = flattenFcl(v);
  const disc: (string | number)[][] = [['Рівень', 'Поле', 'Очікується', 'Факт', 'Рівень', 'Тип', 'Джерела']];
  for (const d of discrepancies) {
    disc.push([
      d.lot ?? 'FCL',
      fieldLabel(d.field),
      d.expected,
      d.actual,
      d.severity,
      d.kind === 'confirmed' ? '🔴 підтверджено' : '🟡 підозра',
      d.citations.map((c) => `${c.file_name ?? c.doc_type}: ${c.value}`).join('; '),
    ]);
  }

  const risk: (string | number)[][] = [['Ризик', 'Рівень', 'Деталі']];
  for (const r of risks) risk.push([r.title, r.severity, r.detail]);

  const lots: (string | number)[][] = [['Партія', 'Постачальник', 'Отримувач', 'Статус', 'Документи', '🔴', '🟡', 'Критичні ризики', 'Файлів']];
  for (const l of v.lots) {
    const c = l.verdicts.checklist;
    lots.push([
      l.lot.name,
      l.lot.supplier_name,
      l.consignee ?? '',
      l.verdicts.derivedStatus,
      `${c.filter((i) => i.status !== 'missing').length}/${c.length}`,
      l.verdicts.discrepancies.filter((d) => d.kind === 'confirmed').length,
      l.verdicts.discrepancies.filter((d) => d.kind !== 'confirmed').length,
      l.verdicts.risks.filter((r) => r.severity === 'error').length,
      l.fileCount,
    ]);
  }
  return { 'Партії': lots, 'Звірка маніфесту': manifest, 'Розбіжності': disc, 'Ризики по партіях': risk };
}

export function appendFclSheets(workbook: Buffer, v: FclVerdicts): Buffer {
  const wb = XLSX.read(workbook, { type: 'buffer' });
  for (const [name, rows] of Object.entries(fclSheetRows(v))) {
    if (wb.SheetNames.includes(name)) continue;
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = (rows[0] ?? []).map(() => ({ wch: 22 }));
    XLSX.utils.book_append_sheet(wb, sheet, name);
  }
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
}
