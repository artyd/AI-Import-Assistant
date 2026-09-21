import {
  lookupUktzedCode,
  lookupDutyRate,
  lookupProductOriginMatch,
  lookupManufacturer,
  lookupAdr,
  checkPrecursor,
  suggestUktzedByTypo,
  type PrecursorHit,
} from './classify.js';
import type { Confidence } from './match.js';
import { lookupMfnRate } from './mfn.js';
import { STATUTORY_TARIFF } from './statutory.js';
import { lookupHsByDescription } from './hsmatch.js';
import { validateUktzedStructure, codeClassPlausible, codeExistsInHs, hsHeadingDescription } from './validate.js';
import type { TariffTable } from '../tariff/tariff.js';
import type { CalcLineInput, ValueSource, VatRegime } from '../types/contract.js';
import type { ProductOriginEntry, AdrEntry } from '../data/index.js';

/**
 * Детермінований шар «грунтування» позиції ПЕРЕД AI/розрахунком.
 * Порядок авторитету: код з таблиці > код зі словника УКТЗЕД > код від AI.
 * Мито береться зі ставки за кодом (kb_coarse у Фазі 1), НЕ вигадується.
 */
export interface RawLine {
  name: string;
  uctzedCode?: string | null;
  qtyKg: number;
  unitPrice: number;
  aiSuggestedCode?: string | null;
  vatRegime?: VatRegime;
  /** «ЛС» (облікова) картка товару — ключ для join цін/кодів між листами. */
  lsCode?: string | null;
}

export interface ResolvedLine {
  calcInput: CalcLineInput;
  code: { value: string | null; source: ValueSource; matchedBy: string | null; confidence: Confidence | null };
  /** Проблема з кодом (структура/правдоподібність), якщо є. */
  codeIssue: string | null;
  /** Офіційний опис позиції HS (WCO), якщо код визначено. */
  hsDescription: string | null;
  origin: ProductOriginEntry | null;
  originConfidence: Confidence | null;
  /** Підказка типу походження, коли речовини немає в базі (з виробника). */
  originTypeHint: string | null;
  adr: AdrEntry | null;
  precursor: PrecursorHit | null;
  warnings: string[];
}

const digitsOnly = (s: string | null | undefined): string => String(s ?? '').replace(/\D/g, '');

export function resolveLine(
  raw: RawLine,
  tariff?: TariffTable | null,
  statutory: TariffTable | null = STATUTORY_TARIFF,
): ResolvedLine {
  const warnings: string[] = [];

  // ── Довідкове визначення речовини (для походження + крос-лінку) ──
  const originMatch = lookupProductOriginMatch(raw.name);
  const origin = originMatch?.entry ?? null;
  let originConfidence = originMatch?.confidence ?? null;
  // Крос-сигнал: якщо речовини немає в базі, але відомий виробник — беремо тип виробництва.
  let originTypeHint: string | null = origin?.originType ?? null;
  if (!origin) {
    const manuf = lookupManufacturer(raw.name);
    if (manuf?.originType) {
      originTypeHint = manuf.originType;
      originConfidence = 'medium';
      warnings.push(`Походження визначено за виробником: ${manuf.originType}.`);
    }
  }

  // ── Код УКТЗЕД ──
  let code: string | null = null;
  let codeSource: ValueSource = 'unknown';
  let matchedBy: string | null = null;
  let codeConfidence: Confidence | null = null;
  // Частковий код HS-6 (пропозиція за описом) — 10-значну структуру не валідуємо.
  let isHs6Partial = false;

  if (raw.uctzedCode && digitsOnly(raw.uctzedCode).length >= 4) {
    code = digitsOnly(raw.uctzedCode);
    codeSource = 'user';
    matchedBy = 'table';
    codeConfidence = 'high';
  } else {
    const dict = lookupUktzedCode(raw.name);
    // Семантичний fallback: якщо курований словник промахнувся — матч за офіційним
    // описом HS (лише коли є токен-ідентичність речовини, інакше мовчить).
    const hs = dict ? null : lookupHsByDescription(raw.name);
    if (dict) {
      code = digitsOnly(dict.code);
      codeSource = 'kb_coarse';
      matchedBy = 'uktzed_dict';
      codeConfidence = dict.confidence;
    } else if (hs) {
      code = digitsOnly(hs.code6);
      codeSource = 'kb_coarse';
      matchedBy = 'hs_desc';
      codeConfidence = hs.confidence;
      isHs6Partial = true;
      warnings.push(
        `Код запропоновано за офіційним описом HS (6 знаків, за «${hs.matched.join(', ')}»): ${hs.desc}. Уточнити 10-значний код за тарифом.`,
      );
    } else if (
      raw.aiSuggestedCode &&
      validateUktzedStructure(raw.aiSuggestedCode).structureValid &&
      codeExistsInHs(raw.aiSuggestedCode)
    ) {
      code = digitsOnly(raw.aiSuggestedCode);
      codeSource = 'ai';
      matchedBy = 'ai_suggested';
      codeConfidence = 'low';
      warnings.push('Код УКТЗЕД запропоновано AI — перевірити за офіційним тарифом.');
    } else if (raw.aiSuggestedCode) {
      const why = !validateUktzedStructure(raw.aiSuggestedCode).structureValid
        ? validateUktzedStructure(raw.aiSuggestedCode).reason
        : 'підпозиція відсутня в номенклатурі HS';
      warnings.push(`Код від AI відхилено (${why}).`);
    } else {
      // Одрук? Підказуємо схожу позицію, але код НЕ проставляємо (у хім-назвах
      // різниця в 1 символ = інша речовина; авто-виправлення було б помилкою).
      const typo = suggestUktzedByTypo(raw.name);
      if (typo) {
        warnings.push(
          `Код УКТЗЕД не визначено. Назва схожа на «${typo.matchedKey}» (${typo.name}, код ${typo.code}) — можливо одрук; перевірити.`,
        );
      } else {
        warnings.push('Код УКТЗЕД не визначено — мито не рахується.');
      }
    }
  }

  // ── Валідація коду (структура + правдоподібність за класом) ──
  // Код — пропозиція (AI або опис HS), а не підтверджений тариф → ставка не авторитетна.
  const codeIsProposal = codeSource === 'ai' || matchedBy === 'hs_desc';
  let codeIssue: string | null = null;
  if (code) {
    // Частковий HS-6 валідний за побудовою (існує в номенклатурі) — перевіряємо лише клас.
    const struct = isHs6Partial ? null : validateUktzedStructure(code);
    if (struct && !struct.structureValid) {
      codeIssue = struct.reason;
      warnings.push(`Код ${code}: ${struct.reason}`);
    } else {
      const plaus = codeClassPlausible(code, origin?.category);
      if (!plaus.plausible) {
        codeIssue = plaus.note;
        warnings.push(plaus.note!);
      }
    }
  }

  // ── Ставка мита за кодом (пріоритет: завантажений тариф > груба таблиця) ──
  let dutyRatePercent: number | null = null;
  let dutyRateSource: ValueSource = 'unknown';
  let vatFromTariff: VatRegime | null = null;
  if (code) {
    // Пріоритет: тариф користувача (runtime) > вбудований статутний 10-значний тариф.
    const te = tariff?.get(code) ?? statutory?.get(code) ?? null;
    if (te) {
      codeConfidence = 'high'; // код підтверджено офіційним тарифом (користувача або статутним)
      vatFromTariff = te.vatRegime ?? null;
      if (te.dutyPercent != null) {
        dutyRatePercent = te.dutyPercent;
        dutyRateSource = 'db'; // авторитетно, не оцінка
      }
    }
    if (dutyRatePercent == null) {
      const mfn = lookupMfnRate(code);
      if (mfn) {
        // Реальна MFN-ставка UA (WITS/UNCTAD) на рівні HS-6.
        dutyRatePercent = mfn.ratePercent;
        // Авторитетно (db) лише коли код надійний і ставка однорідна. Якщо код —
        // пропозиція (HS-опис/AI), ставку позначаємо як оцінку (потребує звірки).
        dutyRateSource = mfn.ranged || codeIsProposal ? 'kb_coarse' : 'db';
        if (mfn.ranged) {
          warnings.push(`Ставка мита ${mfn.ratePercent}% — середня по HS-6 ${mfn.hs6} (є діапазон); уточнити на 10-значному коді.`);
        } else if (codeIsProposal) {
          warnings.push(`Ставка мита ${mfn.ratePercent}% — реальна MFN по HS-6, але код запропоновано автоматично; підтвердити код за тарифом.`);
        }
      } else {
        const duty = lookupDutyRate(code);
        if (duty) {
          dutyRatePercent = duty.ratePercent;
          dutyRateSource = duty.source;
        } else {
          warnings.push(`Ставку мита для коду ${code} не знайдено — уточнити.`);
        }
      }
    }
  }

  const adr = lookupAdr(raw.name);
  const precursor = checkPrecursor(raw.name, code);
  if (precursor) {
    warnings.push(`Прекурсор/контрольована речовина (таблиця ${precursor.table}): ${precursor.note}`);
  }

  const calcInput: CalcLineInput = {
    name: raw.name,
    uctzedCode: code,
    qtyKg: raw.qtyKg,
    unitPrice: raw.unitPrice,
    dutyRatePercent,
    dutyRateSource,
    vatRegime: vatFromTariff ?? raw.vatRegime ?? 'standard_20',
    exciseAmountPerKg: null,
  };

  return {
    calcInput,
    code: { value: code, source: codeSource, matchedBy, confidence: codeConfidence },
    codeIssue,
    hsDescription: hsHeadingDescription(code),
    origin,
    originConfidence,
    originTypeHint,
    adr,
    precursor,
    warnings,
  };
}
