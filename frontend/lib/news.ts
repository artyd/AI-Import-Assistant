// News rubric metadata + helpers for the Новини view.
// The 8 rubric keys + Ukrainian labels are backend-frozen (see GET /api/news);
// "all" is a client-side aggregate tab. Colors reuse existing CSS tokens and
// rotate through them so adjacent rubrics stay visually distinct.

// Order matters — this drives the filter-pill order in NewsView (after "all").
export const NEWS_RUBRIC_ORDER = [
  "customs",
  "ncts",
  "freight",
  "sanctions",
  "ports",
  "fx",
  "pharma",
  "adr",
] as const;

export type NewsRubricKey = (typeof NEWS_RUBRIC_ORDER)[number];

// Ukrainian labels (backend-frozen). "all" is the aggregate tab label.
export const NEWS_RUBRICS: Record<string, string> = {
  all: "Всі новини",
  customs: "Митниця України",
  ncts: "Транзит ЄС / NCTS",
  freight: "Фрахтові ставки",
  sanctions: "Санкції / експортний контроль",
  ports: "Порти",
  fx: "Курси валют / ПДВ",
  pharma: "Фарм/хім регулювання",
  adr: "ADR / небезпечні",
};

// Rubric → accent color (CSS token). Rotates accent/ok/warn/err across the 8
// keys; adjacent rubrics differ. Unknown rubrics fall back to var(--accent).
export const NEWS_RUBRIC_COLORS: Record<string, string> = {
  customs: "var(--accent)",
  ncts: "var(--ok)",
  freight: "var(--warn)",
  sanctions: "var(--err)",
  ports: "var(--accent)",
  fx: "var(--ok)",
  pharma: "var(--warn)",
  adr: "var(--err)",
};

export function newsRubricLabel(key: string): string {
  return NEWS_RUBRICS[key] ?? key;
}

export function newsRubricColor(key: string): string {
  return NEWS_RUBRIC_COLORS[key] ?? "var(--accent)";
}

// Relative time in Ukrainian from an ISO timestamp: «щойно», «2 год тому»,
// «вчора», «3 дні тому». Falls back to a plain date past ~2 weeks.
export function relativeTimeUk(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "щойно";
  if (min < 60) return `${min} хв тому`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} год тому`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "вчора";
  if (days < 7) return `${days} ${pluralUk(days, "день", "дні", "днів")} тому`;
  const weeks = Math.floor(days / 7);
  if (weeks < 3) return `${weeks} ${pluralUk(weeks, "тиждень", "тижні", "тижнів")} тому`;
  return new Date(then).toLocaleDateString("uk-UA", {
    day: "numeric",
    month: "long",
  });
}

// Ukrainian plural selection (one / few / many forms).
function pluralUk(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
