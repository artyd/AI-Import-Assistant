import { parseNumber } from '../sheets/parse.js';
import type { VatRegime } from '../types/contract.js';

/**
 * Користувацький тариф УКТЗЕД (завантажується файлом). Стає авторитетним
 * джерелом коду/ставки мита/ПДВ замість грубої вбудованої таблиці.
 */
export interface TariffEntry {
  code: string; // 10 цифр (або скільки є)
  description?: string;
  dutyPercent: number | null;
  vatRegime?: VatRegime | null;
}

export interface TariffTable {
  size: number;
  /** Пошук за точним кодом, потім за найдовшим префіксом (10/8/6/4/2). */
  get(code: string | null | undefined): TariffEntry | null;
  /** Чи існує код у тарифі (точно). */
  has(code: string | null | undefined): boolean;
}

// Увага: \b не працює з кирилицею — для кириличних патернів його НЕ використовуємо.
const RX = {
  code: /код|уктзед|тнвед|тнвэд|\bhs\b|\bcode\b/i,
  duty: /мит|пошлин|\bduty\b|тариф|ставк.*вв|ввізн/i,
  vat: /пдв|ндс|\bvat\b/i,
  desc: /опис|наимен|наймен|назв|\bdesc/i,
};

function findHeader(rows: (string | number | null | undefined)[][]): { idx: number; cols: { code: number; duty: number; vat: number; desc: number } } | null {
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const r = (rows[i] || []).map((c) => String(c ?? ''));
    const code = r.findIndex((c) => RX.code.test(c));
    if (code < 0) continue;
    const duty = r.findIndex((c) => RX.duty.test(c) && !RX.vat.test(c));
    return {
      idx: i,
      cols: { code, duty, vat: r.findIndex((c) => RX.vat.test(c)), desc: r.findIndex((c) => RX.desc.test(c)) },
    };
  }
  return null;
}

function vatFromPercent(v: number): VatRegime | null {
  if (v >= 19 && v <= 21) return 'standard_20';
  if (v >= 6 && v <= 8) return 'medicine_7';
  if (v === 0) return 'zero_0';
  return null;
}

/** Парсить рядки файла у тариф. Автовизначення колонок. */
export function parseTariffRows(rows: (string | number | null | undefined)[][]): TariffEntry[] {
  const hdr = findHeader(rows);
  if (!hdr) return [];
  const { idx, cols } = hdr;
  const out: TariffEntry[] = [];
  for (let i = idx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const code = String(r[cols.code] ?? '').replace(/\D/g, '');
    if (code.length < 4) continue;
    const dutyRaw = cols.duty >= 0 ? String(r[cols.duty] ?? '').trim() : '';
    const dutyPercent = dutyRaw && !/безмит|вільн|free|-|–/i.test(dutyRaw) ? parseNumber(dutyRaw) : dutyRaw ? 0 : null;
    const vatVal = cols.vat >= 0 ? parseNumber(r[cols.vat]) : NaN;
    out.push({
      code: code.slice(0, 10),
      description: cols.desc >= 0 ? String(r[cols.desc] ?? '').trim() || undefined : undefined,
      dutyPercent: dutyPercent == null || isNaN(dutyPercent) ? null : dutyPercent,
      vatRegime: cols.vat >= 0 && !isNaN(vatVal) ? vatFromPercent(vatVal) : null,
    });
  }
  return out;
}

/** Будує таблицю тарифу з масиву записів. */
export function buildTariffTable(entries: TariffEntry[]): TariffTable {
  const map = new Map<string, TariffEntry>();
  for (const e of entries) if (e.code) map.set(e.code, e);
  return {
    size: map.size,
    has: (code) => map.has(String(code ?? '').replace(/\D/g, '')),
    get: (code) => {
      const d = String(code ?? '').replace(/\D/g, '');
      if (!d) return null;
      if (map.has(d)) return map.get(d)!;
      for (const len of [10, 8, 6, 4, 2]) {
        const hit = [...map.keys()].find((k) => k.length >= len && k.slice(0, len) === d.slice(0, len) && d.length >= len);
        if (hit) return map.get(hit)!;
      }
      return null;
    },
  };
}
