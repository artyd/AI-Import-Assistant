/**
 * Семантичний fallback словника кодів: матч назви товару проти 5613 офіційних
 * 6-значних описів HS (UN Comtrade/WCO), коли курований словник УКТЗЕД промахнувся.
 *
 * КЛЮЧОВЕ:
 *  - Описи HS англійською. Тому матч спрацьовує на ЛАТИНСЬКИХ токенах у назві
 *    (міжнародні INN/INCI-назви субстанцій — часте у фарм/хім-маніфестах).
 *    На чистій кирилиці токенів у словнику немає → внесок 0 → матчу немає
 *    (безпечно: fallback не вигадує код, а мовчить).
 *  - Загальні слова ("other", "acid", "seed") глушаться через IDF-вагу:
 *    рідкісний токен (methionine) важить багато, частий — майже нуль.
 *  - ГЕЙТ ІДЕНТИЧНОСТІ: збіг приймається лише коли є «токен-ідентичність» —
 *    довгий (≥6) рідкісний токен, який по суті і є назвою речовини (methionine,
 *    lysine, caffeine), і НЕ входить у стоп-лист категоріальних слів
 *    ("acid", "gum", "vitamin", "additive"…). Це відсікає хибні збіги на
 *    самих лише категоріальних словах (xanthan gum→gum arabic; ascorbic→B5).
 *  - Пропонує 6-значний рівень HS. Завжди low/medium + потребує звірки за тарифом.
 *    Реальну ставку по HS-6 далі дає lookupMfnRate.
 */
import { HS_DESC } from '../data/index.js';
import { contentTokens, type Confidence } from './match.js';

interface HsEntry {
  code: string;
  desc: string;
  tokens: string[];
}

const ENTRIES: HsEntry[] = [];
const DF = new Map<string, number>(); // document frequency токена серед 6-значних описів
let N = 0;

for (const [code, desc] of Object.entries(HS_DESC)) {
  if (code.length !== 6) continue; // тільки leaf-рівень HS, який можна валідувати й тарифувати
  const tokens = Array.from(new Set(contentTokens(desc)));
  if (tokens.length === 0) continue;
  ENTRIES.push({ code, desc, tokens });
  for (const t of tokens) DF.set(t, (DF.get(t) ?? 0) + 1);
  N++;
}

/** Обернена частота: рідкісний токен → велика вага. +0.5 згладжування. */
function idf(token: string): number {
  return Math.log(N / ((DF.get(token) ?? 0) + 0.5));
}

/**
 * Токени сумісні: точний збіг АБО морфологічний варіант (спільний префікс +
 * близька довжина). Близькість довжини (≥75%) відсікає хибні збіги, коли
 * короткий загальний токен є префіксом довгого чужого слова
 * (acid≁acidified, para≁paracetamol), але лишає відмінки/множину
 * (penicillin~penicillins, lysine~lysines).
 */
function tokenCompat(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (!(a.startsWith(b) || b.startsWith(a))) return false;
  const [short, long] = a.length <= b.length ? [a.length, b.length] : [b.length, a.length];
  return short / long >= 0.75;
}

/**
 * Категоріальні слова HS: рідкісні за IDF, але це НЕ ідентичність речовини —
 * лише клас. Не можуть самі бути токеном-ідентичністю (речовина, перелічена
 * власним іменем у HS-6, все одно матчиться своїм ім'ям).
 */
const CATEGORY_STOPWORDS = new Set([
  'acid', 'acids', 'acidified', 'salt', 'salts', 'gum', 'gums', 'oil', 'oils',
  'vitamin', 'vitamins', 'additive', 'additives', 'mixture', 'mixtures',
  'thickener', 'thickeners', 'colouring', 'coloring', 'pigment', 'pigments',
  'preparation', 'preparations', 'derivative', 'derivatives', 'compound', 'compounds',
  'extract', 'extracts', 'esters', 'ester', 'polymer', 'polymers', 'alkaloids', 'alkaloid',
  'organo', 'inorganic', 'organic',
]);

// Пороги ідентичності (відкалібровані на реальних фарм/хім-назвах):
const IDENTITY_MIN_LEN = 6; // токен-ідентичність — довге слово (не "gum"/"acid")
const IDENTITY_MIN_IDF = 5.5; // рідкісний (≤ ~23 описи) → фактично власне ім'я речовини
const MEDIUM_IDENTITY_IDF = 7.0; // майже унікальний (≤ ~6 описів) → medium, інакше low

/** Чи є токен потенційною ідентичністю речовини (а не категорією). */
function isIdentityToken(tok: string, tokIdf: number): boolean {
  return tok.length >= IDENTITY_MIN_LEN && tokIdf >= IDENTITY_MIN_IDF && !CATEGORY_STOPWORDS.has(tok);
}

interface MatchedTok {
  tok: string;
  idf: number;
}
interface Candidate {
  code6: string;
  desc: string;
  score: number;
  matched: MatchedTok[];
  identityIdf: number; // найбільша IDF серед токенів-ідентичностей (0 якщо нема)
}

/** Скоринг усіх записів; повертає найкращий кандидат за score (без гейта). */
function scoreAll(name: string): Candidate | null {
  const nameToks = contentTokens(name);
  if (nameToks.length === 0) return null;

  let best: Candidate | null = null;
  for (const entry of ENTRIES) {
    let score = 0;
    const matched: MatchedTok[] = [];
    for (const nt of nameToks) {
      let hitIdf = 0;
      let hitTok: string | null = null;
      for (const dt of entry.tokens) {
        if (tokenCompat(nt, dt)) {
          const w = idf(dt);
          if (w > hitIdf) {
            hitIdf = w;
            hitTok = dt;
          }
        }
      }
      if (hitTok) {
        score += hitIdf;
        matched.push({ tok: hitTok, idf: hitIdf });
      }
    }
    if (score <= 0) continue;
    const identityIdf = matched.reduce((mx, m) => (isIdentityToken(m.tok, m.idf) ? Math.max(mx, m.idf) : mx), 0);
    // Пріоритет кандидатам з токеном-ідентичністю; серед рівних — за score.
    const better =
      !best ||
      (identityIdf > 0 && best.identityIdf === 0) ||
      ((identityIdf > 0) === (best.identityIdf > 0) && score > best.score);
    if (better) best = { code6: entry.code, desc: entry.desc, score, matched, identityIdf };
  }
  return best;
}

export interface HsDescMatch {
  code6: string;
  desc: string;
  confidence: Confidence;
  matched: string[];
  score: number;
  bestIdf: number;
}

/** Сирий найкращий кандидат (для калібрування/тестів) — включно з тими, що не проходять гейт. */
export function scoreHsDescription(
  name: string,
): { code6: string; desc: string; matched: string[]; score: number; bestIdf: number; identityIdf: number } | null {
  const c = scoreAll(name);
  if (!c) return null;
  return {
    code6: c.code6,
    desc: c.desc,
    matched: c.matched.map((m) => m.tok),
    score: Math.round(c.score * 10) / 10,
    bestIdf: Math.round(Math.max(0, ...c.matched.map((m) => m.idf)) * 10) / 10,
    identityIdf: Math.round(c.identityIdf * 10) / 10,
  };
}

/**
 * Найкращий 6-значний код HS за описом. Повертає null, якщо немає токена-
 * ідентичності (тоді вище рішення — AI-пропозиція або «код не визначено»).
 */
export function lookupHsByDescription(name: string): HsDescMatch | null {
  const c = scoreAll(name);
  if (!c || c.identityIdf < IDENTITY_MIN_IDF) return null; // жодного власного імені речовини — не вгадуємо

  const confidence: Confidence = c.identityIdf >= MEDIUM_IDENTITY_IDF ? 'medium' : 'low';
  return {
    code6: c.code6,
    desc: c.desc,
    confidence,
    matched: c.matched.map((m) => m.tok),
    score: Math.round(c.score * 10) / 10,
    bestIdf: Math.round(c.identityIdf * 10) / 10,
  };
}
