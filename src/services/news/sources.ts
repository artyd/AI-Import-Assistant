/**
 * News rubrics + the public RSS/Atom feeds they ingest from.
 *
 * The 8 rubric KEYS below are a frozen contract with the frontend filter bar
 * (do not rename — see API_CONTRACT.md). The aggregate "Всі новини" tab is a
 * frontend-only concept (pass no `rubric`, or `rubric=all`, to GET /api/news).
 *
 * Each entry is tagged:
 *   [confirmed] — the RSS/Atom endpoint was fetched and returned valid feed XML
 *                 with recent items (verified 2026-09-15). At least one confirmed
 *                 feed per rubric so a rubric is never empty on a clean deploy.
 *   [gov/edge]  — an official gov/EU feed that a plain bot User-Agent gets a 403
 *                 (Cloudflare/WAF) for, but which typically succeeds server-side
 *                 with the browser-like UA the ingest sends. Kept as a bonus
 *                 source; if it fails at runtime the run still completes (the
 *                 ingest tolerates per-feed failures — one bad feed never aborts).
 *
 * Do NOT hit any of these URLs at build/test time — the network only happens
 * inside the cron job at runtime.
 */

export const RUBRIC_KEYS = [
  'customs',
  'ncts',
  'freight',
  'sanctions',
  'ports',
  'fx',
  'pharma',
  'adr',
] as const;

export type RubricKey = (typeof RUBRIC_KEYS)[number];

/** Ukrainian labels for each rubric (the FE filter bar renders these). */
export const RUBRICS: Record<RubricKey, string> = {
  customs: 'Митниця України',
  ncts: 'Транзит ЄС / NCTS',
  freight: 'Фрахтові ставки',
  sanctions: 'Санкції / експортний контроль',
  ports: 'Порти',
  fx: 'Курси валют / ПДВ',
  pharma: 'Фарм/хім регулювання',
  adr: 'ADR / небезпечні',
};

export function isRubricKey(v: string): v is RubricKey {
  return (RUBRIC_KEYS as readonly string[]).includes(v);
}

export interface NewsSource {
  rubric: RubricKey;
  name: string;
  url: string;
}

export const NEWS_SOURCES: NewsSource[] = [
  // ── Митниця України ─────────────────────────────────────────────────────────
  // [confirmed] Interfax-Ukraine economic wire (Ukrainian, ~25 items, updated daily).
  { rubric: 'customs', name: 'Interfax-Україна (Економіка)', url: 'https://interfax.com.ua/news/economic.rss' },
  // [gov/edge] ЛІГА.Бізнес — WordPress-style feed; 403 to a bot UA, usually fine server-side.
  { rubric: 'customs', name: 'ЛІГА.Бізнес', url: 'https://biz.liga.net/rss.xml' },

  // ── Транзит ЄС / NCTS ────────────────────────────────────────────────────────
  // [confirmed] Customs Declarations UK — EU/UK customs procedures & transit (low volume but valid).
  { rubric: 'ncts', name: 'Customs Declarations UK', url: 'https://www.customs-declarations.uk/feed/' },

  // ── Фрахтові ставки ──────────────────────────────────────────────────────────
  // [confirmed] FreightWaves — ocean/air freight & logistics (WordPress feed).
  { rubric: 'freight', name: 'FreightWaves', url: 'https://www.freightwaves.com/news/feed' },
  // [confirmed] gCaptain — maritime/shipping (WordPress feed).
  { rubric: 'freight', name: 'gCaptain', url: 'https://gcaptain.com/feed/' },
  // [gov/edge] The Loadstar — WordPress `/feed/`; 403 to a bot UA, usually fine server-side.
  { rubric: 'freight', name: 'The Loadstar', url: 'https://theloadstar.com/feed/' },

  // ── Санкції / експортний контроль ────────────────────────────────────────────
  // [confirmed] Baker McKenzie sanctions & export-controls blog (WordPress feed).
  { rubric: 'sanctions', name: 'Baker McKenzie (Sanctions)', url: 'https://sanctionsnews.bakermckenzie.com/feed/' },

  // ── Порти ────────────────────────────────────────────────────────────────────
  // [confirmed] Port of Gdańsk press (WordPress feed).
  { rubric: 'ports', name: 'Port of Gdańsk', url: 'https://www.portgdansk.pl/en/feed/' },
  // [confirmed] Port of Rotterdam news (the real feed path is /en/rss.xml).
  { rubric: 'ports', name: 'Port of Rotterdam', url: 'https://www.portofrotterdam.com/en/rss.xml' },
  // [confirmed] Splash247 — maritime/shipping wire (higher-volume port coverage).
  { rubric: 'ports', name: 'Splash247', url: 'https://splash247.com/feed/' },

  // ── Курси валют / ПДВ ────────────────────────────────────────────────────────
  // [confirmed] РБК-Україна Ukrainian wire (carries FX/economy/tax). NB: НБУ &
  // Мінфін dropped their public RSS (all candidate paths 404), so this is primary.
  { rubric: 'fx', name: 'РБК-Україна', url: 'https://www.rbc.ua/static/rss/all.ukr.rss.xml' },
  // [gov/edge] ДПС (tax) news — 403 to a bot UA, may work server-side.
  { rubric: 'fx', name: 'ДПС України', url: 'https://tax.gov.ua/rss/' },

  // ── Фарм/хім регулювання ─────────────────────────────────────────────────────
  // [confirmed] Pharmaceutical Technology — pharma industry/regulation (WordPress feed).
  { rubric: 'pharma', name: 'Pharmaceutical Technology', url: 'https://www.pharmaceutical-technology.com/feed/' },
  // [gov/edge] ECHA news — 403 to a bot UA, may work server-side. NB: EMA dropped
  // its public rss.xml (all candidate paths 404), so it is not listed.
  { rubric: 'pharma', name: 'ECHA', url: 'https://echa.europa.eu/-/rss' },

  // ── ADR / небезпечні ─────────────────────────────────────────────────────────
  // [confirmed] Bulk Distributor — tank/bulk/hazmat road transport (WordPress feed).
  { rubric: 'adr', name: 'Bulk Distributor', url: 'https://www.bulk-distributor.com/feed/' },
];
