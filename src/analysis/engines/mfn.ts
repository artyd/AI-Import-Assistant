import { UA_MFN, UA_MFN_RANGED } from '../data/index.js';

/**
 * Реальні MFN-ставки ввізного мита України на рівні HS-6.
 * Джерело: WITS / UNCTAD TRAINS (World Bank), reporter=804 (Україна), TARIFFTYPE=MFN,
 * OBS_VALUE = SimpleAverage. Значно точніше за грубу главову таблицю.
 * Обмеження: рівень HS-6 (перші 6 знаків УКТЗЕД); для позицій з діапазоном (MIN≠MAX)
 * значення — середнє, тому позначається як приблизне (уточнити на 10-значному коді).
 */
const MFN = UA_MFN;
const RANGED = new Set(UA_MFN_RANGED);

export interface MfnRate {
  ratePercent: number;
  hs6: string;
  ranged: boolean; // true → середнє по діапазону (приблизне)
}

export function lookupMfnRate(code: string | null | undefined): MfnRate | null {
  const hs6 = String(code ?? '').replace(/\D/g, '').slice(0, 6);
  const rate = MFN[hs6];
  if (hs6.length !== 6 || rate === undefined) return null;
  return { ratePercent: rate, hs6, ranged: RANGED.has(hs6) };
}
