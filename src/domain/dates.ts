/**
 * Parses a date from the free-form strings extraction returns. `Date.parse`
 * alone silently fails on the DD.MM.YYYY / DD/MM/YYYY formats that dominate
 * UA/EU shipping documents → an actually-expired certificate or passed deadline
 * would produce NO risk at all. Try the day-first formats explicitly first, then
 * fall back to native parsing (ISO etc.).
 */
export function parseFlexibleDate(dateStr: string): number | null {
  const s = dateStr.trim();
  const m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/.exec(s);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const t = Date.UTC(year, month - 1, day);
      if (!Number.isNaN(t)) return t;
    }
  }
  const native = Date.parse(s);
  return Number.isNaN(native) ? null : native;
}
