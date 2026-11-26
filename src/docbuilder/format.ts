/**
 * Number and date formats used by the trade documents: Ukrainian-style numbers
 * in the tables («25 010,00», «2 200», «1,73»), English amounts in clause 2.1
 * («25,010.00»), dates «July 31, 2026» / «31 липня 2026 р.».
 */
const NBSP = ' ';

function group(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Round half-up to `d` decimals without binary drift (1.005 → 1.01). */
export function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** «25 010,00» — money, always two decimals. */
export function moneyUk(n: number): string {
  const [i, f] = round(n).toFixed(2).split('.');
  return `${group(i!, NBSP)},${f}`;
}

/** «25,010.00» — money in the English clause. */
export function moneyEn(n: number): string {
  const [i, f] = round(n).toFixed(2).split('.');
  return `${group(i!, ',')}.${f}`;
}

/** «2 200», «1 033,4» — a quantity or weight: no trailing zeros. */
export function qtyUk(n: number): string {
  const r = round(n, 3);
  const [i, f] = String(r).split('.');
  return f ? `${group(i!, NBSP)},${f}` : group(i!, NBSP);
}

/** «1,73», «25,01», «202,00» — a unit price: at least two decimals, up to four. */
export function priceUk(n: number): string {
  const r = round(n, 4);
  let s = r.toFixed(4).replace(/0{1,2}$/, '');
  if (!/\.\d{2,}$/.test(s)) s = r.toFixed(2);
  const [i, f] = s.split('.');
  return `${group(i!, NBSP)},${f}`;
}

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const UK_MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

function parts(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/** «July 31, 2026» (empty for an invalid date). */
export function dateEn(iso: string): string {
  const p = parts(iso);
  return p ? `${EN_MONTHS[p.m - 1]} ${p.d}, ${p.y}` : '';
}

/** «31 липня 2026 р.». */
export function dateUk(iso: string): string {
  const p = parts(iso);
  return p ? `${p.d} ${UK_MONTHS_GEN[p.m - 1]} ${p.y} р.` : '';
}

/** «31072026» — the date part of a contract number. */
export function dateCompact(iso: string): string {
  const p = parts(iso);
  return p ? `${String(p.d).padStart(2, '0')}${String(p.m).padStart(2, '0')}${p.y}` : '';
}
