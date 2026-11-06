/**
 * Feed goods need a veterinary (health) certificate. Postgres regexes (`~*`) run
 * over a file's Markdown sections; shared by the shipment and FCL snapshots.
 */
export const FEED_SQL_RX = 'feed[ -]?grade|feed additive|for animal feed|animal feed|кормов|кормова добавка|кормовая';
export const VET_SQL_RX = 'health certificate|veterinary certificate|sanitary certificate|ветеринарн[а-яіїє]* сертиф|ветсертиф';
