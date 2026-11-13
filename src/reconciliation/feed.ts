/**
 * Feed goods need a veterinary (health) certificate. Postgres regexes (`~*`) run
 * over a file's Markdown sections; shared by the shipment and FCL snapshots.
 */
// «animal feed» but not the MSDS boilerplate «keep away from food, drink and
// animal feedingstuffs» (it turned an insecticide and a hormone into feed goods).
export const FEED_SQL_RX = 'feed[ -]?grade|feed additive|for animal feed|animal feed(?!ing)|кормов|кормова добавка|кормовая';

/**
 * Documents that describe WHAT the goods are (and so may say «feed grade»):
 * the commercial papers and the CoA. An MSDS, a label photo or an unrelated
 * file mentioning feed does not make the goods feed.
 */
const FEED_EVIDENCE_TYPES = new Set(['invoice', 'packing_list', 'contract', 'quality_certificate', 'customs_declaration']);
const SDS_NAME_RX = /(^|[^a-z])m?sds([^a-z]|$)|safety[\s_-]*data|паспорт\s*безпек/i;
export function isFeedEvidence(docType: string | null, fileName: string): boolean {
  return !!docType && FEED_EVIDENCE_TYPES.has(docType) && !SDS_NAME_RX.test(fileName);
}
export const VET_SQL_RX = 'health certificate|veterinary certificate|sanitary certificate|ветеринарн[а-яіїє]* сертиф|ветсертиф';
