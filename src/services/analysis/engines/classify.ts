import {
  PRODUCT_ORIGIN_KB,
  MANUFACTURER_KB,
  ADR_SUBSTANCE_DB,
  UKTZED_CODE_DB,
  HS_DUTY_TABLE,
  PRECURSOR_WATCH,
  type ProductOriginEntry,
  type ManufacturerEntry,
  type AdrEntry,
} from '../data/index.js';
import type { ValueSource } from '../types/contract.js';
import { matchByAliases, fuzzyNearestByAliases, normalizeName, type Confidence } from './match.js';

/**
 * Движок 2 — класифікація/пошук за довідниками через точний токен-матчер
 * (замість наївного substring). Кожен збіг повертає впевненість.
 */

export const normalize = normalizeName;

// ── Код УКТЗЕД за назвою ──────────────────────────────────────────
export interface CodeMatch {
  code: string;
  name: string;
  matchedBy: 'alias';
  confidence: Confidence;
}
export function lookupUktzedCode(name: string): CodeMatch | null {
  const m = matchByAliases(UKTZED_CODE_DB, name);
  if (!m || m.confidence === 'low') return null;
  return { code: m.entry.code, name: m.entry.name, matchedBy: 'alias', confidence: m.confidence };
}

// ── Fuzzy-підказка на одрук (НЕ автозаміна — див. fuzzyNearestByAliases) ──
export interface TypoSuggestion {
  code: string;
  name: string;
  matchedKey: string;
  nameToken: string;
  distance: number;
}
/** Близька за написанням позиція словника — щоб підказати можливий одрук людині. */
export function suggestUktzedByTypo(name: string): TypoSuggestion | null {
  const h = fuzzyNearestByAliases(UKTZED_CODE_DB, name);
  if (!h) return null;
  return { code: h.entry.code, name: h.entry.name, matchedKey: h.keyToken, nameToken: h.nameToken, distance: h.distance };
}

// ── Ставка мита за кодом (порт lookupDutyRate @9255) ──────────────
export interface DutyMatch {
  ratePercent: number;
  source: ValueSource;
  matchedKey: string;
}
export function lookupDutyRate(hsCode: string | null | undefined): DutyMatch | null {
  if (!hsCode) return null;
  const digits = String(hsCode).replace(/\D/g, '');
  if (!digits || digits.length < 4) return null;
  for (const len of [10, 8, 6, 4]) {
    const key = digits.slice(0, len);
    const rate = HS_DUTY_TABLE[key];
    if (rate !== undefined) {
      return { ratePercent: rate, source: 'kb_coarse', matchedKey: key };
    }
  }
  const chapter = digits.slice(0, 2);
  const chapterRate = HS_DUTY_TABLE[chapter];
  if (chapterRate !== undefined) {
    return { ratePercent: chapterRate, source: 'kb_coarse', matchedKey: chapter };
  }
  return null;
}

// ── Походження товару ─────────────────────────────────────────────
export interface OriginKBMatch {
  entry: ProductOriginEntry;
  confidence: Confidence;
}
export function lookupProductOriginMatch(name: string, category?: string): OriginKBMatch | null {
  const hay = category ? `${name} ${category}` : name;
  const m = matchByAliases(PRODUCT_ORIGIN_KB, hay);
  if (!m || m.confidence === 'low') return null;
  return { entry: m.entry, confidence: m.confidence };
}
export function lookupProductOrigin(name: string, category?: string): ProductOriginEntry | null {
  return lookupProductOriginMatch(name, category)?.entry ?? null;
}

export function lookupManufacturer(text: string): ManufacturerEntry | null {
  const m = matchByAliases(MANUFACTURER_KB, text);
  return m && m.confidence !== 'low' ? m.entry : null;
}

export function lookupAdr(name: string): AdrEntry | null {
  const m = matchByAliases(ADR_SUBSTANCE_DB, name);
  return m && m.confidence !== 'low' ? m.entry : null;
}

// ── Прекурсори / контрольовані речовини (порт @9270) ──────────────
export interface PrecursorHit {
  table: number;
  note: string;
  matchedByCode: boolean;
}
export function checkPrecursor(name: string, hsCode?: string | null): PrecursorHit | null {
  const digits = String(hsCode ?? '').replace(/\D/g, '');
  for (const p of PRECURSOR_WATCH) {
    const byName = p.name.test(name);
    const byCode = digits ? p.code.test(digits) : false;
    if (byName || byCode) {
      return { table: p.table, note: p.note, matchedByCode: byCode && !byName };
    }
  }
  return null;
}
