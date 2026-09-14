// Типізовані завантажувачі мігрованих довідників (з index.html → JSON).
//
// JSON НЕ імпортується через `import ... from './x.json'` (крихко під NodeNext +
// наш білд): читаємо файли в рантаймі через fs, шлях виводимо з import.meta.url,
// тому лоадер працює однаково в tsx (src/…) і у зібраному dist/…
// (JSON копіюється туди scripts/copy-assets.mjs).
import { readFileSync } from 'node:fs';

function loadJson<T>(file: string): T {
  const url = new URL(`./${file}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

export interface ProductOriginEntry {
  keys: string[];
  originType: string;
  productionMethod: string;
  category: string;
  confidence: string;
}
export interface ManufacturerEntry {
  keys: string[];
  originType?: string;
  productionMethod?: string;
  gmpStatus?: string;
  country?: string;
}
export interface AdrEntry {
  keys: string[];
  un: string;
  class: string;
  pg: string;
  label: string;
  desc: string;
}
export interface UktzedEntry {
  keys: string[];
  code: string;
  name: string;
}
export type HsDutyTable = Record<string, number>;

interface RegexJson { __regex: true; source: string; flags: string }
interface PrecursorRaw {
  name: RegexJson;
  code: RegexJson;
  table: number;
  note: string;
}
export interface PrecursorEntry {
  name: RegExp;
  code: RegExp;
  table: number;
  note: string;
}

export const PRODUCT_ORIGIN_KB = loadJson<ProductOriginEntry[]>('product_origin_kb.json');
export const MANUFACTURER_KB = loadJson<ManufacturerEntry[]>('manufacturer_kb.json');
export const ADR_SUBSTANCE_DB = loadJson<AdrEntry[]>('adr_substance_db.json');
export const HS_DUTY_TABLE = loadJson<HsDutyTable>('hs_duty_table.json');

// База кодів + оверлей синонімів (розширює розпізнавання, коди ті самі).
import { UKTZED_CODE_DB_EXTRA } from './uktzed_code_db_extra.js';
export const UKTZED_CODE_DB: UktzedEntry[] = [
  ...loadJson<UktzedEntry[]>('uktzed_code_db.json'),
  ...UKTZED_CODE_DB_EXTRA,
];

// Регідратація regex з {__regex, source, flags}
export const PRECURSOR_WATCH: PrecursorEntry[] = loadJson<PrecursorRaw[]>('precursor_watch.json').map((p) => ({
  name: new RegExp(p.name.source, p.name.flags),
  code: new RegExp(p.code.source, p.code.flags),
  table: p.table,
  note: p.note,
}));

// ── Довідники, які раніше імпортувались напряму в окремих движках ──
// Централізовано тут, щоб уся робота з JSON проходила через один рантайм-лоадер.

/** Офіційні 6-значні описи HS (UN Comtrade/WCO) — семантичний fallback словника. */
export const HS_DESC = loadJson<Record<string, string>>('hs_desc.json');

/** Реальні MFN-ставки України на рівні HS-6 (WITS/UNCTAD). */
export const UA_MFN = loadJson<Record<string, number>>('ua_mfn.json');

/** HS-6 позиції, де MFN — середнє по діапазону (приблизне). */
export const UA_MFN_RANGED = loadJson<string[]>('ua_mfn_ranged.json');

/** Множина існуючих 6-значних підпозицій HS (валідація коду). */
export const HS_VALID6 = loadJson<string[]>('hs_valid6.json');

/** Офіційні описи HS-позицій (4-значна/2-значна глава), англ. (WCO). */
export const HS_HEAD = loadJson<Record<string, string>>('hs_head.json');

/** Сирі записи вбудованого статутного 10-значного тарифу (наразі порожньо). */
export const UA_TARIFF10_RAW = loadJson<unknown[]>('ua_tariff10.json');
