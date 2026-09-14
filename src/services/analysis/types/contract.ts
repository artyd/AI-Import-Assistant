import { z } from 'zod';

/**
 * Єдине джерело правди для контракту даних детермінованого ядра аналізу.
 * Головна вимога: жодне число не показується без позначки, звідки воно і чи це
 * оцінка (NumberWithSource → {value, estimated, source}).
 */

// ── Базові довідники ──────────────────────────────────────────────
export const Incoterm = z.enum([
  'EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP',
]);
export type Incoterm = z.infer<typeof Incoterm>;

export const Currency = z.enum(['USD', 'EUR', 'UAH', 'CNY']);
export type Currency = z.infer<typeof Currency>;

/**
 * Походження кожного числа/поля. Ключова вимога проєкту: жодне число
 * не показується без позначки, звідки воно і чи це оцінка.
 */
export const ValueSource = z.enum([
  'user',       // введено користувачем (найточніше)
  'db',         // офіційний тариф/довідник із бази
  'kb_coarse',  // мігрована груба таблиця HS_DUTY_TABLE (тимчасово, до реального тарифу)
  'ai',         // запропоновано AI (потребує перевірки)
  'fallback',   // оцінка за замовчуванням (напр. фрахт ×1.10)
  'unknown',    // не визначено
]);
export type ValueSource = z.infer<typeof ValueSource>;

export const NumberWithSource = z.object({
  value: z.number(),
  estimated: z.boolean(),
  source: ValueSource,
});
export type NumberWithSource = z.infer<typeof NumberWithSource>;

// ── Податкові режими ──────────────────────────────────────────────
export const VatRegime = z.enum([
  'standard_20',  // 20% — загальна ставка
  'medicine_7',   // 7% — зареєстровані ЛЗ та медвироби (ПКУ ст.193)
  'zero_0',       // 0%
]);
export type VatRegime = z.infer<typeof VatRegime>;

export const VAT_RATE_BY_REGIME: Record<VatRegime, number> = {
  standard_20: 0.20,
  medicine_7: 0.07,
  zero_0: 0.0,
};

export const DutyRegime = z.enum([
  'UA_MFN',        // режим найбільшого сприяння (за замовчуванням)
  'UA_EU_DCFTA',   // преференція ЄС↔Україна (потрібен EUR.1 / origin proof)
]);
export type DutyRegime = z.infer<typeof DutyRegime>;

// ── Вхід для руху платежів ────────────────────────────────────────

/** Витрати на рівні відправлення (для розрахунку митної вартості). */
export const ShipmentCostInput = z.object({
  incoterm: Incoterm,
  currency: Currency,
  /** Загальний фрахт до митного кордону, у валюті відправлення. */
  freight: z.number().nonnegative().nullable().default(null),
  /** Загальна страховка, у валюті відправлення. */
  insurance: z.number().nonnegative().nullable().default(null),
  /** Курс: 1 одиниця валюти = fxToUAH грн. */
  fxToUAH: z.number().positive().nullable().default(null),
  /** Дата курсу (ISO), для аудиту. */
  fxDate: z.string().nullable().default(null),
});
export type ShipmentCostInput = z.infer<typeof ShipmentCostInput>;

/** Одна товарна позиція на вході розрахунку. */
export const CalcLineInput = z.object({
  name: z.string(),
  uctzedCode: z.string().nullable().default(null),
  qtyKg: z.number().nonnegative(),
  /** Ціна за кг у валюті відправлення. */
  unitPrice: z.number().nonnegative(),
  /** Ставка мита, %. null → не визначено (движок не рахує мито). */
  dutyRatePercent: z.number().nonnegative().nullable().default(null),
  dutyRateSource: ValueSource.default('unknown'),
  vatRegime: VatRegime.default('standard_20'),
  /** Акциз за кг (грн або валюта), опційно. */
  exciseAmountPerKg: z.number().nonnegative().nullable().default(null),
});
export type CalcLineInput = z.infer<typeof CalcLineInput>;

export const CalcRequest = z.object({
  shipment: ShipmentCostInput,
  lines: z.array(CalcLineInput),
});
export type CalcRequest = z.infer<typeof CalcRequest>;

// ── Вихід руху платежів ───────────────────────────────────────────
export const CalcLineResult = z.object({
  name: z.string(),
  uctzedCode: z.string().nullable(),
  qtyKg: z.number(),
  goodsValue: NumberWithSource,      // qty × ціна
  customsValue: NumberWithSource,    // митна вартість (валюта відправлення)
  customsValueUAH: NumberWithSource.nullable(),
  dutyRatePercent: NumberWithSource.nullable(),
  duty: NumberWithSource.nullable(),
  excise: NumberWithSource,
  vatRegime: VatRegime,
  vatRatePercent: z.number(),
  vat: NumberWithSource.nullable(),
  totalPayable: NumberWithSource.nullable(),
  needsReview: z.boolean(),
  warnings: z.array(z.string()),
});
export type CalcLineResult = z.infer<typeof CalcLineResult>;

export const CalcSummary = z.object({
  currency: Currency,
  totalCustomsValue: NumberWithSource,
  totalCustomsValueUAH: NumberWithSource.nullable(),
  totalDuty: NumberWithSource,
  totalExcise: NumberWithSource,
  totalVAT: NumberWithSource,
  totalPayable: NumberWithSource,
  anyEstimated: z.boolean(),
  anyNeedsReview: z.boolean(),
  fxToUAH: z.number().nullable(),
  fxDate: z.string().nullable(),
});
export type CalcSummary = z.infer<typeof CalcSummary>;

export const CalcResponse = z.object({
  lines: z.array(CalcLineResult),
  summary: CalcSummary,
});
export type CalcResponse = z.infer<typeof CalcResponse>;
