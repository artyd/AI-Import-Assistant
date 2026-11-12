/**
 * Deterministic fact check (spec 010, part C). Pure logic, no I/O, no LLM:
 *  - `findValue`      — is this figure/number/code in the source text? (verify_facts)
 *  - `extractFigures` — which checkable figures does an answer state? (post-answer net)
 *  - `checkFigures`   — which of those no source text supports?
 *
 * "Supported" means the value occurs in the text after normalisation: NBSP and
 * spaces, thousands separators («1 000» / «1,000»), decimal comma vs dot, case,
 * dash kinds, HS-code spacing, date notation and unit spelling («кг» / «kg»).
 */

export interface CorpusDoc {
  file: string;
  pages: { page: number | null; text: string }[];
}

export interface FoundIn {
  file: string;
  page?: number;
}

/** found = value (with its unit) is there; number_only = the number is there but not next to the unit. */
export type FindStatus = 'found' | 'number_only' | 'not_found';

export interface FindResult {
  status: FindStatus;
  foundIn: FoundIn[];
  /** The time budget ran out before every document was searched. */
  timedOut?: boolean;
}

export interface FindOptions {
  /** Stop searching after this many locations (default 8). */
  maxHits?: number;
  /** Date.now() deadline. */
  deadline?: number;
}

// ── Normalisation ────────────────────────────────────────────────────────────

const SPACES = /[      ]/g;
const DASHES = /[‐-―−]/g;

/** Lower-case, one kind of space, one kind of dash. */
export function normalizeText(s: string): string {
  return s.replace(SPACES, ' ').replace(DASHES, '-').toLowerCase();
}

const normCache = new WeakMap<object, string>();
function pageText(p: { text: string }): string {
  let t = normCache.get(p);
  if (t === undefined) {
    t = normalizeText(p.text);
    normCache.set(p, t);
  }
  return t;
}

// Unit spellings treated as the same unit.
const UNIT_GROUPS: string[][] = [
  ['кг', 'kg', 'kgs', 'kilogram', 'kilograms', 'кілограм', 'кілограмів', 'килограмм'],
  ['т', 't', 'mt', 'тонн', 'тонна', 'тонни', 'ton', 'tons', 'tonne', 'tonnes'],
  ['шт', 'pcs', 'pc', 'pieces', 'штук', 'ea'],
  ['л', 'l', 'ltr', 'liter', 'litre', 'літр', 'літрів'],
  ['м3', 'm3', 'м³', 'm³', 'cbm'],
  ['м2', 'm2', 'м²', 'm²'],
  ['usd', '$', 'дол', 'долар', 'доларів'],
  ['eur', '€', 'євро'],
  ['грн', 'uah', '₴'],
  ['%', 'percent', 'відсотків'],
  ['plt', 'plts', 'pallet', 'pallets', 'пал', 'палет', 'палета', 'палети'],
  ['ctn', 'ctns', 'carton', 'cartons', 'коробок', 'місць'],
  ['bag', 'bags', 'мішків', 'мішки'],
];

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function unitAlternatives(unit: string): string {
  const u = unit.toLowerCase();
  const group = UNIT_GROUPS.find((g) => g.includes(u)) ?? [u];
  return [...group].sort((a, b) => b.length - a.length).map(esc).join('|');
}

const UNIT_WORDS = [...new Set(UNIT_GROUPS.flat())].sort((a, b) => b.length - a.length).map(esc).join('|');

// ── Number parsing ───────────────────────────────────────────────────────────

interface ParsedNumber {
  int: string;
  frac: string;
}

/** «1 000,50» / «1,000.50» / «1.000,50» / «1000.50» → { int: '1000', frac: '50' }; null if not a number. */
function parseNumber(raw: string): ParsedNumber | null {
  const s = raw.replace(/[\s']/g, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const seps = [...s.matchAll(/[.,]/g)].map((m) => ({ ch: m[0], at: m.index ?? 0 }));
  if (seps.length === 0) return { int: s, frac: '' };
  const last = seps[seps.length - 1]!;
  const after = s.slice(last.at + 1);
  const sameChar = seps.every((x) => x.ch === last.ch);
  const digitsBefore = s.slice(0, last.at).replace(/[.,]/g, '');
  if (seps.length >= 2 && sameChar) return { int: s.replace(/[.,]/g, ''), frac: '' }; // grouping only (1.000.000, 2915.90.00.00)
  if (seps.length === 1 && after.length === 3 && digitsBefore !== '0') return { int: s.replace(/[.,]/g, ''), frac: '' }; // 1,000
  if (after === '') return { int: digitsBefore, frac: '' };
  return { int: digitsBefore, frac: after };
}

const SEP = `[ .,']?`;
const LEFT = `(?<![\\p{L}\\p{N}][-/.,])(?<![\\p{L}\\p{N}])`;
const RIGHT_NUM = `(?!\\d)(?![.,\\-/]\\d)`;

function numberPattern(n: ParsedNumber): string {
  const digits = n.int.replace(/^0+(?=\d)/, '').split('');
  const anywhere = digits.length >= 6; // codes and big numbers: any spacing
  const parts = digits.map((d, i) => {
    if (i === 0) return d;
    const sepOk = anywhere || (digits.length - i) % 3 === 0;
    return (sepOk ? SEP : '') + d;
  });
  const frac = n.frac.replace(/0+$/, '');
  const tail = frac ? `[.,]${frac}0*` : `(?:[.,]0+)?`;
  return `${parts.join('')}${tail}`;
}

// ── Matchers ─────────────────────────────────────────────────────────────────

interface Matcher {
  strong: RegExp;
  /** Weaker proof (the number without its unit). */
  weak?: RegExp;
}

function re(src: string): RegExp {
  return new RegExp(src, 'iu');
}

function dateMatcher(d: string, m: string, y: string): Matcher {
  const dd = `0?${Number(d)}`;
  const mm = `0?${Number(m)}`;
  const s = `[./\\-]`;
  return {
    strong: re(`(?<!\\d)(?:${dd}${s}${mm}${s}${y}|${y}${s}${mm}${s}${dd})(?!\\d)`),
  };
}

export function buildMatcher(value: string): Matcher | null {
  const v = normalizeText(value).trim();
  if (!v) return null;

  let m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(v);
  if (m) return dateMatcher(m[1]!, m[2]!, m[3]!);
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return dateMatcher(m[3]!, m[2]!, m[1]!);

  // number + unit («25 кг», «12 345,67 USD», «5%»)
  const nu = /^(\d[\d\s.,']*?)\s*([\p{L}%€$₴][\p{L}\d%€$₴³²]*)\.?$/u.exec(v);
  if (nu) {
    const n = parseNumber(nu[1]!);
    if (n) {
      const num = numberPattern(n);
      const unit = unitAlternatives(nu[2]!);
      return {
        strong: re(`${LEFT}${num}\\s*(?:${unit})(?![\\p{L}])`),
        weak: re(`${LEFT}${num}${RIGHT_NUM}`),
      };
    }
  }

  // plain number / numeric code
  if (/^[\d\s.,']+$/.test(v)) {
    const n = parseNumber(v);
    if (n) return { strong: re(`${LEFT}${numberPattern(n)}${RIGHT_NUM}`) };
  }

  // alphanumeric number (container, invoice, B/L, registration): separators ignored
  const compact = [...v].filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (compact.length === 0) return null;
  return {
    strong: re(`(?<![\\p{L}\\p{N}])${compact.map(esc).join(`[\\s.,\\-/_]?`)}(?![\\p{L}\\p{N}])`),
  };
}

/** Searches `docs` for `value`. */
export function findValue(value: string, docs: CorpusDoc[], opts: FindOptions = {}): FindResult {
  const matcher = buildMatcher(value);
  if (!matcher) return { status: 'not_found', foundIn: [] };
  const maxHits = opts.maxHits ?? 8;

  const scan = (rx: RegExp): { hits: FoundIn[]; timedOut: boolean } => {
    const hits: FoundIn[] = [];
    for (const d of docs) {
      for (const p of d.pages) {
        if (opts.deadline && Date.now() > opts.deadline) return { hits, timedOut: true };
        if (rx.test(pageText(p))) {
          hits.push(p.page === null ? { file: d.file } : { file: d.file, page: p.page });
          if (hits.length >= maxHits) return { hits, timedOut: false };
        }
      }
    }
    return { hits, timedOut: false };
  };

  const strong = scan(matcher.strong);
  if (strong.hits.length) return { status: 'found', foundIn: strong.hits };
  if (matcher.weak && !strong.timedOut) {
    const weak = scan(matcher.weak);
    if (weak.hits.length) return { status: 'number_only', foundIn: weak.hits };
    return { status: 'not_found', foundIn: [], ...(weak.timedOut ? { timedOut: true } : {}) };
  }
  return { status: 'not_found', foundIn: [], ...(strong.timedOut ? { timedOut: true } : {}) };
}

// ── Figure extraction from an answer ─────────────────────────────────────────

export type FigureKind = 'container' | 'date' | 'docnumber' | 'quantity' | 'hs' | 'amount';

export interface Figure {
  raw: string;
  kind: FigureKind;
}

const PAGE_REF = /(?:стор(?:інк\w*)?|арк|с|pp?|pages?)\.?\s*\d+(?:\s*[-–,]\s*\d+)*/giu;
const ADVISORY = /кандидат|варіант|можлив|ймовірн|припуска|орієнтов|candidate/iu;
const NUM = `\\d+(?:[ \\u00a0]\\d{3})*(?:[.,]\\d+)?`;

function cleanLine(line: string): string {
  return line
    .replace(/[*`_]+/g, '')
    .replace(/^\s*(?:[-•]\s*)?\d{1,2}[.)]\s+/, '') // «1.» «2)»
    .replace(new RegExp(`^\\s*\\d{1,2}(?:\\.\\d{1,2}){1,3}\\s+(?!(?:${UNIT_WORDS})(?![\\p{L}]))`, 'iu'), '') // «1.2 Розділ»
    .replace(PAGE_REF, ' ');
}

/** Checkable figures an answer states: quantities with units, HS codes, document / container numbers, dates, amounts. */
export function extractFigures(text: string): Figure[] {
  const out: Figure[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    if (/\(висновок\)/iu.test(rawLine)) continue;
    let work = cleanLine(rawLine);
    const advisory = ADVISORY.test(work);

    const take = (rx: RegExp, kind: FigureKind, group = 0): void => {
      work = work.replace(rx, (...args: unknown[]) => {
        const match = args[0] as string;
        const raw = ((group ? (args[group] as string | undefined) : match) ?? '').trim();
        if (raw && !(advisory && kind === 'hs')) {
          const key = normalizeText(raw).replace(/[\s.,\-/_]/g, '');
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ raw, kind });
          }
        }
        return ' '.repeat(match.length);
      });
    };

    take(/(?<![\p{L}\d])[A-Z]{3}[UJZ]\s?\d{6}\s?\d(?!\d)/gu, 'container');
    take(/(?<![\d.\-/])(?:\d{1,2}[./]\d{1,2}[./]\d{4}|\d{4}-\d{2}-\d{2})(?![\d])/g, 'date');
    take(/№\s*([\p{L}\d][\p{L}\d\-/.]*\d[\p{L}\d\-/]*|\d[\d\-/]*)/gu, 'docnumber', 1);
    take(/(?<![\p{L}\d\-/])(?=[\p{Lu}\d]*\d)(?=[\p{Lu}\d]*\p{Lu})[\p{Lu}\d]+(?:[-/][\p{Lu}\d]+)+(?![\p{L}\d])/gu, 'docnumber');
    take(new RegExp(`(?<![\\p{L}\\d.,])(${NUM}\\s?(?:${UNIT_WORDS})(?![\\p{L}]))`, 'giu'), 'quantity', 1);
    take(/(?<![\d.,\-/])(\d{4}(?:[ .]?\d{2}){1,3})(?![\d]|[.,]\d)/g, 'hs', 1);
    take(/(?:код[ауи]?|укт\s*зед|hs|позиці\w*)\W{0,15}(\d{4})(?!\d)/giu, 'hs', 1);
    take(/(?<![\d.,])(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+[.,]\d{2}(?!\d)|\d{5,})(?![\d])/g, 'amount', 1);
  }
  return out;
}

/** Figures of an answer no document supports (raw strings, as stated). */
export function checkFigures(figures: Figure[], docs: CorpusDoc[], opts: FindOptions = {}): string[] {
  const unsupported: string[] = [];
  for (const f of figures) {
    const r = findValue(f.raw, docs, { ...opts, maxHits: 1 });
    if (r.status === 'not_found' && !r.timedOut) unsupported.push(f.raw);
  }
  return unsupported;
}

// ── Post-answer check (used by the agent loop) ───────────────────────────────

/** Text of every tool_result block in the given messages (this turn's reads and verdicts). */
export function toolResultTexts(messages: readonly { role: string; content: unknown }[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content as { type?: string; content?: unknown }[]) {
      if (b?.type !== 'tool_result') continue;
      if (typeof b.content === 'string') out.push(b.content);
      else if (Array.isArray(b.content)) {
        for (const c of b.content as { type?: string; text?: string }[]) if (c?.type === 'text' && c.text) out.push(c.text);
      }
    }
  }
  return out;
}

export interface AnswerCheckInput {
  answer: string;
  /** tool_result texts of the turn */
  toolTexts: string[];
  userMessage: string;
  /** The shipment's files + extracted fields; called only if the cheap sources leave something unsupported. */
  loadShipment?: () => Promise<CorpusDoc[]>;
  deadline?: number;
}

export interface AnswerCheckResult {
  figures: number;
  unsupported: string[];
}

/** Checks the figures an answer states against the turn's tool results, the user's message and the shipment's files. */
export async function runAnswerCheck(input: AnswerCheckInput): Promise<AnswerCheckResult> {
  const figures = extractFigures(input.answer);
  if (figures.length === 0) return { figures: 0, unsupported: [] };
  const turnDocs: CorpusDoc[] = [
    { file: '(результати інструментів)', pages: input.toolTexts.map((text) => ({ page: null, text })) },
    { file: '(повідомлення користувача)', pages: [{ page: null, text: input.userMessage }] },
  ];
  const opts = { deadline: input.deadline };
  let unsupported = checkFigures(figures, turnDocs, opts);
  if (unsupported.length > 0 && input.loadShipment) {
    const shipment = await input.loadShipment();
    const left = new Set(unsupported);
    unsupported = checkFigures(figures.filter((f) => left.has(f.raw)), shipment, opts);
  }
  return { figures: figures.length, unsupported };
}
