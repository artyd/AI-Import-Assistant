import { selectActualSheet, type SheetInput } from '../sheets/selectActualSheet.js';
import { extractRows, buildReferenceMap, type ColumnMap } from '../sheets/parse.js';
import { resolveLine, type ResolvedLine } from '../engines/resolve.js';
import { calculatePayments } from '../engines/payment.js';
import { buildOriginOptions, originKeyFromType, categoryChecks, type OriginProfile, type OriginPin, type OriginCheck } from '../engines/origin.js';
import {
  ShipmentCostInput,
  type CalcResponse,
  type CalcLineResult,
  type VatRegime,
} from '../types/contract.js';
import type { TariffTable } from '../tariff/tariff.js';

/**
 * Детермінований аналіз без AI та без БД — усе працює на чистих рушіях +
 * вбудованих довідниках. AI (euChecks/uaChecks) додається окремо у B-2.
 */
export interface AnalysisLine {
  resolved: ResolvedLine;
  calc: CalcLineResult;
  originOptions: OriginProfile[];
  appChecks: { eu: OriginCheck[]; ua: OriginCheck[] };
}

export interface AnalysisResult {
  selectedSheetName: string;
  selectedSheetDate: string | null;
  reason: string;
  ignored: string[];
  columns: ColumnMap;
  lines: AnalysisLine[];
  calc: CalcResponse;
  warnings: string[];
}

export function analyzeDeterministic(
  sheets: SheetInput[],
  shipmentInput: unknown,
  currentDate: Date,
  defaultVatRegime: VatRegime = 'standard_20',
  tariff?: TariffTable | null,
): AnalysisResult {
  const shipment = ShipmentCostInput.parse(shipmentInput);

  const { selected, reason, ignored } = selectActualSheet(sheets, currentDate);
  if (!selected) {
    throw new Error(
      'Не знайдено листів із товарною таблицею (потрібна колонка назви + числові колонки).',
    );
  }

  const { rows, columns } = extractRows(selected);
  if (rows.length === 0) {
    throw new Error(
      `Лист "${selected.name}" не містить товарних рядків (перевірте, що є колонка з назвою товару).`,
    );
  }

  // Hybrid enrichment: the chosen sheet gives the item LIST; when it lacks a price
  // or УКТЗЕД column, pull those per item from other sheets by the «ЛС» card. This
  // is enrichment only — it never ADDS items, so the count stays the current sheet's.
  const joinWarnings: string[] = [];
  if (columns.price < 0 || columns.code < 0) {
    const ref = buildReferenceMap(sheets, currentDate);
    let pricedFromRef = 0;
    let codedFromRef = 0;
    for (const r of rows) {
      if (!r.lsCode) continue;
      const hit = ref.get(r.lsCode);
      if (!hit) continue;
      if ((r.unitPrice ?? 0) <= 0 && hit.price) {
        r.unitPrice = hit.price;
        pricedFromRef++;
      }
      if (!r.uctzedCode && hit.code) {
        r.uctzedCode = hit.code;
        codedFromRef++;
      }
    }
    if (pricedFromRef > 0) joinWarnings.push(`Ціни підтягнуто з листа закупки за кодом ЛС для ${pricedFromRef} позицій.`);
    if (codedFromRef > 0) joinWarnings.push(`Коди УКТЗЕД підтягнуто з листа закупки за кодом ЛС для ${codedFromRef} позицій.`);
  }

  const resolved = rows.map((r) => resolveLine({ ...r, vatRegime: defaultVatRegime }, tariff));
  const calc = calculatePayments({
    shipment,
    lines: resolved.map((r) => r.calcInput),
  });

  const lines: AnalysisLine[] = resolved.map((r, i) => {
    // Якщо база/виробник визначили речовину — «пінимо» її походження як рекомендоване.
    const pinType = r.origin?.originType ?? r.originTypeHint;
    const pinKey = pinType ? originKeyFromType(pinType) : null;
    const pinned: OriginPin | null =
      pinKey && r.originConfidence ? { key: pinKey, confidence: r.originConfidence } : null;
    return {
      resolved: r,
      calc: calc.lines[i]!,
      originOptions: buildOriginOptions(
        {
          name: r.calcInput.name,
          uctzedCode: r.code.value,
          category: r.origin?.category,
          originType: r.origin?.originType ?? null,
          productionMethod: r.origin?.productionMethod ?? null,
        },
        pinned,
      ),
      appChecks: categoryChecks(r.origin?.category),
    };
  });

  const warnings = Array.from(
    new Set([...joinWarnings, ...lines.flatMap((l) => [...l.resolved.warnings, ...l.calc.warnings])]),
  );

  return {
    selectedSheetName: selected.name,
    selectedSheetDate: selected.parsedDate
      ? selected.parsedDate.toLocaleDateString('uk-UA')
      : null,
    reason,
    ignored,
    columns,
    lines,
    calc,
    warnings,
  };
}
