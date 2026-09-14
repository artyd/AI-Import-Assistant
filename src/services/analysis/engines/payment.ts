import {
  type CalcRequest,
  type CalcResponse,
  type CalcLineResult,
  type CalcSummary,
  type Incoterm,
  type NumberWithSource,
  type ValueSource,
  VAT_RATE_BY_REGIME,
} from '../types/contract.js';

/**
 * Движок 1 — розрахунок митних платежів. Чистий, детермінований, БЕЗ AI.
 * Замінює хардкод FOB×1.10, ПДВ 20% завжди.
 *
 * Головні виправлення:
 *  - митна вартість = реальний FOB+Freight+Insurance за Incoterms; ×1.10 лише як
 *    ЯВНО помічений fallback, а не мовчазне припущення;
 *  - ставка мита ніколи не «вигадується» тут — приходить готовою (з бази/AI) або
 *    лишається null → мито не рахується, ставиться needsReview;
 *  - ПДВ за режимом (20% / 7% для ліків / 0%), а не завжди 20%;
 *  - кожне число несе {value, estimated, source}.
 */

/** Множник-fallback, коли фрахт невідомий. Тепер ЯВНИЙ і позначений. */
export const FREIGHT_FALLBACK_MULTIPLIER = 1.1;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const num = (value: number, source: ValueSource, estimated = false): NumberWithSource => ({
  value: round2(value),
  estimated,
  source,
});

/**
 * Чи включає Incoterm перевезення/страхування до митного кордону імпорту.
 * Спрощена, але практична модель для митної вартості при ввезенні.
 */
export function incotermCoverage(incoterm: Incoterm): {
  freightIncluded: boolean;
  insuranceIncluded: boolean;
} {
  switch (incoterm) {
    // Продавець не оплачує основне перевезення — фрахт додаємо.
    case 'EXW':
    case 'FCA':
    case 'FAS':
    case 'FOB':
      return { freightIncluded: false, insuranceIncluded: false };
    // Фрахт включено, страхування — ні.
    case 'CFR':
    case 'CPT':
      return { freightIncluded: true, insuranceIncluded: false };
    // Фрахт і страхування включено.
    case 'CIF':
    case 'CIP':
    // Доставка до місця призначення — вважаємо все включеним (спрощення для MVP).
    case 'DAP':
    case 'DPU':
    case 'DDP':
      return { freightIncluded: true, insuranceIncluded: true };
    default:
      return { freightIncluded: false, insuranceIncluded: false };
  }
}

export function calculatePayments(req: CalcRequest): CalcResponse {
  const { shipment, lines } = req;
  const coverage = incotermCoverage(shipment.incoterm);

  const goodsValues = lines.map((l) => l.qtyKg * l.unitPrice);
  const totalGoods = goodsValues.reduce((a, b) => a + b, 0);

  // Розподіл фрахту/страховки по позиціях пропорційно вартості товару.
  const share = (idx: number): number => (totalGoods > 0 ? (goodsValues[idx] ?? 0) / totalGoods : 0);

  const results: CalcLineResult[] = lines.map((line, i) => {
    const warnings: string[] = [];
    let needsReview = false;

    const goods = goodsValues[i] ?? 0;
    const goodsValue = num(goods, 'user');

    // ── Митна вартість ──
    let customsValueRaw = goods;
    let cvEstimated = false;
    let cvSource: ValueSource = 'user';

    // Фрахт
    if (!coverage.freightIncluded) {
      if (shipment.freight != null) {
        customsValueRaw += shipment.freight * share(i);
      } else {
        // Fallback: фрахт невідомий → груба оцінка ×1.10, ПОЗНАЧЕНА.
        customsValueRaw = goods * FREIGHT_FALLBACK_MULTIPLIER;
        cvEstimated = true;
        cvSource = 'fallback';
        warnings.push(
          `Фрахт не вказано для ${shipment.incoterm}: митна вартість оцінена як вартість товару ×${FREIGHT_FALLBACK_MULTIPLIER} (орієнтовно).`,
        );
        needsReview = true;
      }
    }
    // Страхування (додаємо лише якщо не включено і не спрацював fallback)
    if (!coverage.insuranceIncluded && !cvEstimated) {
      if (shipment.insurance != null) {
        customsValueRaw += shipment.insurance * share(i);
      } else if (!coverage.freightIncluded) {
        // Страховку не вказано — не роздуваємо, лише попереджаємо.
        warnings.push('Страхування не вказано — не включено в митну вартість.');
      }
    }

    const customsValue = num(customsValueRaw, cvSource, cvEstimated);

    // UAH-еквівалент
    let customsValueUAH: NumberWithSource | null = null;
    if (shipment.fxToUAH != null) {
      customsValueUAH = num(customsValueRaw * shipment.fxToUAH, cvSource, cvEstimated);
    } else {
      warnings.push('Курс до UAH не задано — суми в UAH не розраховано.');
    }

    // ── Мито ──
    let dutyRate: NumberWithSource | null = null;
    let duty: NumberWithSource | null = null;
    if (line.dutyRatePercent != null) {
      const rateEstimated = line.dutyRateSource === 'ai' || line.dutyRateSource === 'kb_coarse';
      dutyRate = num(line.dutyRatePercent, line.dutyRateSource, rateEstimated);
      duty = num(
        (customsValueRaw * line.dutyRatePercent) / 100,
        cvEstimated || rateEstimated ? 'fallback' : 'db',
        cvEstimated || rateEstimated,
      );
      if (rateEstimated) {
        needsReview = true;
        warnings.push(
          line.dutyRateSource === 'ai'
            ? 'Ставку мита запропоновано AI — перевірити брокером за УКТЗЕД.'
            : 'Ставку мита взято з грубої таблиці (глава) — уточнити за реальним тарифом.',
        );
      }
    } else {
      needsReview = true;
      warnings.push('Ставку мита не визначено — мито не розраховано.');
    }

    // ── Акциз ──
    const exciseRaw = line.exciseAmountPerKg != null ? line.exciseAmountPerKg * line.qtyKg : 0;
    const excise = num(exciseRaw, line.exciseAmountPerKg != null ? 'db' : 'unknown');

    // ── ПДВ ──
    const vatRatePercent = VAT_RATE_BY_REGIME[line.vatRegime];
    let vat: NumberWithSource | null = null;
    let totalPayable: NumberWithSource | null = null;
    if (duty != null) {
      const vatBase = customsValueRaw + duty.value + exciseRaw;
      const vatEstimated = customsValue.estimated || duty.estimated;
      vat = num(vatBase * vatRatePercent, vatEstimated ? 'fallback' : 'db', vatEstimated);
      totalPayable = num(
        duty.value + exciseRaw + vat.value,
        vatEstimated ? 'fallback' : 'db',
        vatEstimated,
      );
    } else {
      warnings.push('ПДВ не розраховано, бо не визначено мито.');
    }

    return {
      name: line.name,
      uctzedCode: line.uctzedCode,
      qtyKg: line.qtyKg,
      goodsValue,
      customsValue,
      customsValueUAH,
      dutyRatePercent: dutyRate,
      duty,
      excise,
      vatRegime: line.vatRegime,
      vatRatePercent,
      vat,
      totalPayable,
      needsReview,
      warnings,
    };
  });

  // ── Зведена ──
  const sum = (pick: (r: CalcLineResult) => number): number =>
    results.reduce((acc, r) => acc + pick(r), 0);

  const anyEstimated = results.some(
    (r) =>
      r.customsValue.estimated ||
      r.duty?.estimated ||
      r.vat?.estimated ||
      r.dutyRatePercent?.estimated,
  );
  const anyNeedsReview = results.some((r) => r.needsReview);

  const totalCustomsValue = sum((r) => r.customsValue.value);
  const totalDuty = sum((r) => r.duty?.value ?? 0);
  const totalExcise = sum((r) => r.excise.value);
  const totalVAT = sum((r) => r.vat?.value ?? 0);

  const summary: CalcSummary = {
    currency: shipment.currency,
    totalCustomsValue: num(totalCustomsValue, 'db', anyEstimated),
    totalCustomsValueUAH:
      shipment.fxToUAH != null
        ? num(totalCustomsValue * shipment.fxToUAH, 'db', anyEstimated)
        : null,
    totalDuty: num(totalDuty, 'db', anyEstimated),
    totalExcise: num(totalExcise, 'db'),
    totalVAT: num(totalVAT, 'db', anyEstimated),
    totalPayable: num(totalDuty + totalExcise + totalVAT, 'db', anyEstimated),
    anyEstimated,
    anyNeedsReview,
    fxToUAH: shipment.fxToUAH ?? null,
    fxDate: shipment.fxDate ?? null,
  };

  return { lines: results, summary };
}
