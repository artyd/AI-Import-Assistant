/**
 * The letter goes to a foreign supplier in English: from a bilingual value
 * ("Метопрен / S-METHOPRENE", "«TEKHINFORM PLUS» LLC / ТОВ «ТЕХІНФОРМ ПЛЮС»")
 * keep the Latin part. Single-language values are returned as is.
 */
export function latinPart(v: string): string {
  const parts = v.split(/\s+\/\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return v.trim();
  const latinShare = (x: string) => (x.match(/[A-Za-z]/g)?.length ?? 0) / Math.max(1, (x.match(/\p{L}/gu)?.length ?? 0));
  return parts.reduce((best, x) => (latinShare(x) > latinShare(best) ? x : best));
}

/** "29189990 90 0" / "2918999090" → "2918 99 90 90" (10 digits); else as read. */
export function formatHs(v: string): string {
  const digits = v.replace(/\D/g, '');
  if (digits.length < 10) return v.trim();
  const d = digits.slice(0, 10);
  return `${d.slice(0, 4)} ${d.slice(4, 6)} ${d.slice(6, 8)} ${d.slice(8, 10)}`;
}

/** ISO "2026-06-03" → "03.06.2026"; other formats kept as written in the document. */
export function formatDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  return m ? `${m[3]}.${m[2]}.${m[1]}` : v.trim();
}
