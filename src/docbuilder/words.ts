/**
 * Amounts in words for the bilingual contract: «865,00 доларів США (вісімсот
 * шістдесят п'ять доларів США 00 центів)» and «USD 865.00 (eight hundred
 * sixty-five US dollars and zero cents)». Pure; integers up to 999 999 999 999.
 */
export type Currency = 'USD' | 'EUR';

// ---------- Ukrainian ----------
const UK_ONES_M = ['', 'один', 'два', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
const UK_ONES_F = ['', 'одна', 'дві', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
const UK_TEENS = [
  'десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять',
  "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять",
];
const UK_TENS = ['', '', 'двадцять', 'тридцять', 'сорок', "п'ятдесят", 'шістдесят', 'сімдесят', 'вісімдесят', "дев'яносто"];
const UK_HUNDREDS = ['', 'сто', 'двісті', 'триста', 'чотириста', "п'ятсот", 'шістсот', 'сімсот', 'вісімсот', "дев'ятсот"];

/** Ukrainian plural form index: 0 — один, 1 — два..чотири, 2 — п'ять+. */
export function ukPlural(n: number): 0 | 1 | 2 {
  const m100 = n % 100;
  const m10 = n % 10;
  if (m100 >= 11 && m100 <= 14) return 2;
  if (m10 === 1) return 0;
  if (m10 >= 2 && m10 <= 4) return 1;
  return 2;
}

function ukTriad(n: number, feminine: boolean): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) out.push(UK_HUNDREDS[h]!);
  if (rest >= 10 && rest < 20) out.push(UK_TEENS[rest - 10]!);
  else {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    if (t) out.push(UK_TENS[t]!);
    if (o) out.push((feminine ? UK_ONES_F : UK_ONES_M)[o]!);
  }
  return out;
}

const UK_SCALES: { forms: [string, string, string]; feminine: boolean }[] = [
  { forms: ['', '', ''], feminine: false },
  { forms: ['тисяча', 'тисячі', 'тисяч'], feminine: true },
  { forms: ['мільйон', 'мільйони', 'мільйонів'], feminine: false },
  { forms: ['мільярд', 'мільярди', 'мільярдів'], feminine: false },
];

/** Integer → Ukrainian words in the masculine gender («двадцять п'ять тисяч десять»). */
export function ukNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`ukNumber: invalid ${n}`);
  if (n === 0) return 'нуль';
  const words: string[] = [];
  let scale = 0;
  let rest = n;
  const chunks: string[][] = [];
  while (rest > 0) {
    const triad = rest % 1000;
    const s = UK_SCALES[scale];
    if (!s) throw new Error('ukNumber: too large');
    if (triad) {
      const w = ukTriad(triad, s.feminine);
      if (scale > 0) w.push(s.forms[ukPlural(triad)]);
      chunks.unshift(w);
    }
    rest = Math.floor(rest / 1000);
    scale++;
  }
  for (const c of chunks) words.push(...c);
  return words.join(' ');
}

const UK_CUR: Record<Currency, { major: [string, string, string]; minor: [string, string, string]; nameGen: string; name: string }> = {
  USD: { major: ['долар США', 'долари США', 'доларів США'], minor: ['цент', 'центи', 'центів'], nameGen: 'доларів США', name: 'долари США' },
  EUR: { major: ['євро', 'євро', 'євро'], minor: ['цент', 'центи', 'центів'], nameGen: 'євро', name: 'євро' },
};

function split(amount: number): { major: number; minor: number } {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`invalid amount ${amount}`);
  const cents = Math.round(amount * 100);
  return { major: Math.floor(cents / 100), minor: cents % 100 };
}

/** «двадцять п'ять тисяч десять доларів США 00 центів». */
export function amountWordsUk(amount: number, cur: Currency): string {
  const { major, minor } = split(amount);
  const c = UK_CUR[cur];
  return `${ukNumber(major)} ${c.major[ukPlural(major)]} ${String(minor).padStart(2, '0')} ${c.minor[ukPlural(minor)]}`;
}

/** «доларів США» after a decimal amount («865,00 доларів США»). */
export function currencyAfterAmountUk(cur: Currency): string {
  return UK_CUR[cur].nameGen;
}

/** «долари США» — the currency as a noun («Валютою платежу є долари США»). */
export function currencyNameUk(cur: Currency): string {
  return UK_CUR[cur].name;
}

// ---------- English ----------
const EN_ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const EN_SCALES = ['', 'thousand', 'million', 'billion'];

function enTriad(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(`${EN_ONES[h]} hundred`);
  if (rest) {
    if (rest < 20) parts.push(EN_ONES[rest]!);
    else {
      const t = EN_TENS[Math.floor(rest / 10)]!;
      const o = rest % 10;
      parts.push(o ? `${t}-${EN_ONES[o]}` : t);
    }
  }
  return parts.join(' ');
}

/** Integer → English words («twenty-five thousand ten»). */
export function enNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`enNumber: invalid ${n}`);
  if (n === 0) return 'zero';
  const chunks: string[] = [];
  let rest = n;
  let scale = 0;
  while (rest > 0) {
    const triad = rest % 1000;
    if (scale >= EN_SCALES.length) throw new Error('enNumber: too large');
    if (triad) chunks.unshift(scale ? `${enTriad(triad)} ${EN_SCALES[scale]}` : enTriad(triad));
    rest = Math.floor(rest / 1000);
    scale++;
  }
  return chunks.join(' ');
}

const EN_CUR: Record<Currency, { one: string; many: string; minorOne: string; minorMany: string }> = {
  USD: { one: 'US dollar', many: 'US dollars', minorOne: 'cent', minorMany: 'cents' },
  EUR: { one: 'euro', many: 'euros', minorOne: 'cent', minorMany: 'cents' },
};

/** «twenty-five thousand ten US dollars and zero cents». */
export function amountWordsEn(amount: number, cur: Currency): string {
  const { major, minor } = split(amount);
  const c = EN_CUR[cur];
  return `${enNumber(major)} ${major === 1 ? c.one : c.many} and ${enNumber(minor)} ${minor === 1 ? c.minorOne : c.minorMany}`;
}
