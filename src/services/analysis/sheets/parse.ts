import * as XLSX from 'xlsx';
import type { SheetInput, SheetMeta } from './selectActualSheet.js';
import { findDataHeader } from './selectActualSheet.js';
import type { RawLine } from '../engines/resolve.js';

// ── Парсинг файлів ────────────────────────────────────────────────

/** Простий CSV-парсер (лапки, екрановані "", CRLF). */
export function parseCSV(text: string): string[][] {
  const t = text.replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * Читає буфер файла → масив листів {name, rows}.
 * Server-side порт браузерного parseFile: CSV/TXT парситься напряму, Excel — через
 * SheetJS (той самий пакет `xlsx`, що вже у бекенді). Приймає Buffer/Uint8Array
 * замість браузерного File.
 */
export function parseWorkbook(data: Buffer | Uint8Array, filename: string): SheetInput[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const text = new TextDecoder('utf-8').decode(bytes);
    return [{ name: filename.replace(/\.[^.]+$/, ''), rows: parseCSV(text) }];
  }
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true, cellNF: false, cellText: false });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws) return { name, rows: [] };
    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false,
    }) as (string | number | null)[][];
    return { name, rows };
  });
}

// ── Витяг товарних рядків ─────────────────────────────────────────

export interface ColumnMap {
  name: number;
  qty: number;
  price: number;
  code: number;
}

const RX = {
  name: /номенкл|наименован|назв|товар|product|item|опис|description/i,
  qty: /вага|маса|вес|нетто|нет\b|кільк|кол[-\s]*[вим]|\bкг\b|\bkg\b|\bqty\b|quantity|\bшт\b/i,
  price: /цін|цена|price|варт|закуп|\bсум|amount|\busd\b|\beur\b|\$/i,
  code: /уктзед|тнвэд|hs[\s-]*code|\bhs\b|\bкод\b/i,
};

/** Мапа колонок за рядком заголовків. Повертає індекси (-1 якщо немає). */
export function mapColumns(header: (string | number | null | undefined)[]): ColumnMap {
  const find = (rx: RegExp): number =>
    header.findIndex((c) => rx.test(String(c ?? '')));
  return { name: find(RX.name), qty: find(RX.qty), price: find(RX.price), code: find(RX.code) };
}

/** Парсинг числа з форматів "1 234,56" / "1,234.56" / "12.5". */
export function parseNumber(v: unknown): number {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v ?? '').trim().replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // остання роздільна — десяткова
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// Anchored at start (^) so real product names that merely CONTAIN one of these
// stems (e.g. «Окситетрациклин основание») are NOT dropped — only rows that BEGIN
// like a total / note / logistics line are. NB: JS `\b` is ASCII-only, so it does
// NOT work as a word boundary for Cyrillic — we rely on distinctive stems instead
// («основн» matches «основной» but not «основание»; «готов» matches «готовность»).
const JUNK_RX =
  /^(итого|разом|усього|всього|всего|total|сума|подсумок|примеч|коммент|note|№|основн|готов|судов|отгруз|отправк|график|реквизит|оплат|доставк)/i;

// Trailing free-form sales/logistics notes that get typed into the name cell.
// Everything from the marker onward is stripped from the product name.
const NAME_NOTE_RX =
  /\s+(мы возили|кого возил|мониторинг|если хорош|подтвержд|одобрен|заказан|подписал|опасник|клиент|поставщик|local charges|include warehouse|don'?t\s+more|cpt-?|до спт|до\s+\S+\s+львов).*/i;

/**
 * Cleans a raw manifest name cell down to the product name: keeps only the first
 * line (notes/CAS usually land on subsequent lines) and strips a trailing sales/
 * logistics note. Falls back to the raw text if cleaning would empty it.
 */
export function cleanProductName(raw: unknown): string {
  const firstLine = String(raw ?? '').split(/\r?\n/)[0] ?? '';
  const cleaned = firstLine
    .replace(NAME_NOTE_RX, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    // Drop a dangling separator and/or a trailing lone preposition left by the cut
    // (requires a leading separator so it can't eat into a real trailing word).
    .replace(/[\s,\-–—]+(?:на|до|в|у|по|з|із|для|от|за|и|та)?[\s,\-–—]*$/i, '')
    .trim();
  return cleaned || String(raw ?? '').trim();
}

/** Чи це «сміттєвий» рядок (підсумки, нотатки, порожні). */
export function isJunkRow(name: string): boolean {
  const n = name.trim();
  if (n.length < 2) return true;
  if (JUNK_RX.test(n)) return true;
  if (/^\d+([.,]\d+)?$/.test(n)) return true; // лише число
  // Notes that carry only dates / no substance letters (e.g. «готовность… 20.09»).
  if (!/[a-zа-яіїєґ]{3,}/i.test(n)) return true;
  return false;
}

/** Витягує товарні рядки з обраного листа. */
export function extractRows(meta: SheetMeta): { rows: RawLine[]; columns: ColumnMap } {
  const rows = meta.sheet.rows;
  const headerIdx = meta.headerIdx >= 0 ? meta.headerIdx : findDataHeader(rows);
  const header = rows[headerIdx] || [];
  const columns = mapColumns(header);
  if (columns.name < 0) return { rows: [], columns };

  const out: RawLine[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = cleanProductName(r[columns.name]);
    if (!name || isJunkRow(name)) continue;
    const qtyKg = columns.qty >= 0 ? parseNumber(r[columns.qty]) : 0;
    const unitPrice = columns.price >= 0 ? parseNumber(r[columns.price]) : 0;
    const codeRaw = columns.code >= 0 ? String(r[columns.code] ?? '').trim() : '';
    out.push({ name, qtyKg, unitPrice, uctzedCode: codeRaw || null });
  }
  return { rows: out, columns };
}
