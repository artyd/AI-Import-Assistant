/**
 * Калібрування ризику, який повернув AI: непідтверджена підстава пільгового ПДВ 7 %
 * — це «уточнити», а не «Критичний». Критичність лишається для жорстких стоп-факторів
 * (прекурсор, заборона/санкції, наркотичні, подвійне використання).
 */
const VAT_ONLY = /пдв|\bvat\b/i;
const HARD_STOP = /прекурсор|заборон|санкц|наркот|подвійн|dual.?use|контрольован|embargo/i;

export function calibrateRisk(
  risk: string | null,
  riskNote: string,
  hasPrecursor: boolean,
): { risk: string | null; riskNote: string } {
  if (risk !== 'Критичний' || hasPrecursor) return { risk, riskNote };
  if (!VAT_ONLY.test(riskNote) || HARD_STOP.test(riskNote)) return { risk, riskNote };
  return {
    risk: 'Середній',
    riskNote: `Уточнити підставу ПДВ 7 % (реєстрація ЛЗ / перелік КМУ) — не блокує оформлення. ${riskNote}`.trim(),
  };
}
