import * as XLSX from 'xlsx';
import { currentStep } from './logic.js';
import type { SupplySettings, SupplyShipment } from './types.js';

/** The register as an Excel workbook: one row per shipment, plus every step. */
export function buildSupplyXlsx(shipments: SupplyShipment[], settings: SupplySettings): Buffer {
  const wb = XLSX.utils.book_new();
  const fields = settings.fields;

  const head = ['Категорія', 'Товар / партія', 'Поточний етап', 'План', 'Факт', 'Наступна дія', 'Примітка', ...fields.map((f) => f.name), 'Архів', 'Оновлено'];
  const rows = shipments.map((s) => {
    const st = currentStep(s.steps);
    return [
      s.category,
      s.name,
      st?.name ?? '',
      st?.plan ?? '',
      st?.actual ?? '',
      s.action,
      s.note,
      ...fields.map((f) => s.custom[f.id] ?? ''),
      s.archived ? 'так' : '',
      s.updatedAt.slice(0, 10),
    ];
  });
  const main = XLSX.utils.aoa_to_sheet([head, ...rows]);
  main['!cols'] = head.map((h, i) => ({ wch: i === 1 || i === 6 ? 36 : Math.max(12, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, main, 'Поставки');

  const stepRows = shipments.flatMap((s) =>
    s.steps.map((st) => [s.name, st.name, st.plan, st.actual, { active: 'поточний', done: 'виконано', pending: 'далі' }[st.state], st.note]),
  );
  const steps = XLSX.utils.aoa_to_sheet([['Товар / партія', 'Етап', 'План', 'Факт', 'Стан', 'Коментар'], ...stepRows]);
  steps['!cols'] = [{ wch: 36 }, { wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, steps, 'Етапи');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
