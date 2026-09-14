/**
 * News rubrics + the public RSS/Atom feeds they ingest from.
 *
 * The 8 rubric KEYS below are a frozen contract with the frontend filter bar
 * (do not rename — see API_CONTRACT.md). The aggregate "Всі новини" tab is a
 * frontend-only concept (pass no `rubric`, or `rubric=all`, to GET /api/news).
 *
 * NEWS_SOURCES is a best-effort, user-approved starter set of public feeds. The
 * ingest (src/services/news/index.ts) tolerates individual feed failures — one
 * bad/unreachable feed never aborts the run — so it is safe to keep entries here
 * whose RSS endpoint is unconfirmed. Such entries are marked `TODO(verify)` and
 * should be swapped for a confirmed RSS URL, an official API, or an HTML-scrape
 * adapter later. Do NOT hit any of these URLs at build/test time — the network
 * only happens inside the cron job at runtime.
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

/**
 * Public feeds per rubric. "confirmed RSS" = a stable RSS/Atom endpoint I am
 * reasonably confident exists (usually a WordPress `/feed/` or a documented
 * gov/EU feed). "TODO(verify)" = the source is relevant but I have no confirmed
 * clean RSS — the URL is a best-effort guess and likely needs an HTML scrape or
 * official API before it yields items.
 */
export const NEWS_SOURCES: NewsSource[] = [
  // ── Митниця України ─────────────────────────────────────────────────────────
  // TODO(verify): Держмитслужба has no confirmed public RSS — needs HTML scrape or official API.
  { rubric: 'customs', name: 'Держмитслужба України', url: 'https://customs.gov.ua/rss' },
  // ЛІГА:ЗАКОН business/legal feed — confirmed RSS (WordPress-style feed).
  { rubric: 'customs', name: 'ЛІГА.Бізнес', url: 'https://biz.liga.net/rss.xml' },
  // TODO(verify): Мінфін (minfin.com.ua) news RSS unconfirmed — best-effort URL.
  { rubric: 'customs', name: 'Мінфін', url: 'https://minfin.com.ua/ua/news/rss/' },

  // ── Транзит ЄС / NCTS ────────────────────────────────────────────────────────
  // TODO(verify): EU TAXUD / NCTS has no confirmed news RSS — needs the EU newsroom API or scrape.
  { rubric: 'ncts', name: 'EU TAXUD (Customs)', url: 'https://taxation-customs.ec.europa.eu/rss_en' },
  // TODO(verify): EU Customs Union newsroom — best-effort RSS path.
  { rubric: 'ncts', name: 'EU Customs newsroom', url: 'https://taxation-customs.ec.europa.eu/news_en/rss' },

  // ── Фрахтові ставки ──────────────────────────────────────────────────────────
  // The Loadstar — confirmed RSS (WordPress `/feed/`).
  { rubric: 'freight', name: 'The Loadstar', url: 'https://theloadstar.com/feed/' },
  // FreightWaves — confirmed RSS (WordPress feed).
  { rubric: 'freight', name: 'FreightWaves', url: 'https://www.freightwaves.com/news/feed' },

  // ── Санкції / експортний контроль ────────────────────────────────────────────
  // TODO(verify): OFAC "Recent Actions" — RSS availability unconfirmed; may need the Treasury feed/API.
  { rubric: 'sanctions', name: 'OFAC Recent Actions', url: 'https://ofac.treasury.gov/media/rss.xml' },
  // TODO(verify): EU sanctions / FSD newsroom — no confirmed RSS, best-effort path.
  { rubric: 'sanctions', name: 'EU sanctions newsroom', url: 'https://finance.ec.europa.eu/news_en/rss' },

  // ── Порти ────────────────────────────────────────────────────────────────────
  // TODO(verify): Port of Rotterdam press — RSS unconfirmed, best-effort URL.
  { rubric: 'ports', name: 'Port of Rotterdam', url: 'https://www.portofrotterdam.com/en/news-and-press-releases/rss' },
  // TODO(verify): Port of Hamburg (HHLA/HPA) press — RSS unconfirmed.
  { rubric: 'ports', name: 'Port of Hamburg', url: 'https://www.hafen-hamburg.de/en/press/feed/' },
  // TODO(verify): Port of Gdańsk press — RSS unconfirmed.
  { rubric: 'ports', name: 'Port of Gdańsk', url: 'https://www.portgdansk.pl/en/feed/' },

  // ── Курси валют / ПДВ ────────────────────────────────────────────────────────
  // TODO(verify): НБУ (bank.gov.ua) publishes RSS but the exact endpoint needs confirming.
  { rubric: 'fx', name: 'НБУ', url: 'https://bank.gov.ua/ua/news/rss' },
  // TODO(verify): ДПС (tax.gov.ua) news RSS unconfirmed — best-effort URL.
  { rubric: 'fx', name: 'ДПС України', url: 'https://tax.gov.ua/rss/' },

  // ── Фарм/хім регулювання ─────────────────────────────────────────────────────
  // EMA news — confirmed RSS (europa.eu publishes an rss.xml news feed).
  { rubric: 'pharma', name: 'EMA', url: 'https://www.ema.europa.eu/en/rss.xml' },
  // TODO(verify): ECHA news RSS endpoint unconfirmed — best-effort path.
  { rubric: 'pharma', name: 'ECHA', url: 'https://echa.europa.eu/-/rss' },
  // TODO(verify): ДЕЦ (Державний експертний центр МОЗ) has no confirmed RSS — needs scrape.
  { rubric: 'pharma', name: 'ДЕЦ МОЗ', url: 'https://www.dec.gov.ua/feed/' },

  // ── ADR / небезпечні ─────────────────────────────────────────────────────────
  // TODO(verify): UNECE ADR (Transport of Dangerous Goods) — RSS unconfirmed, best-effort URL.
  { rubric: 'adr', name: 'UNECE ADR', url: 'https://unece.org/transport/dangerous-goods/rss.xml' },
];
