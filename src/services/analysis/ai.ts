import { callAnalysisAi } from '../aiProxy/index.js';
import { AiResponse, type AiItem } from './types/aiSchema.js';
import { normalize } from './engines/classify.js';
import { ZED_TOPICS, type ZedTopic } from './data/index.js';

/**
 * AI enrichment step for the consolidated analysis (B-2). Ported from the
 * accuracy branch (lib/ai/prompt.ts + app/api/checks/route.ts): a grounded
 * system prompt (the "critical data-source rule" — use ONLY the CONTEXT block,
 * never invent norms/codes/rates) plus a per-batch user prompt. The deterministic
 * engine already computed every number; the model returns ONLY descriptive /
 * classification fields (origin type, category, EU/UA broker checks, risk).
 *
 * Routes through the BYOK aiProxy (`callAnalysisAi`): built-in server-side Claude
 * (MODEL from config) unless the owner opted into a BYOK provider — the key
 * always stays server-side. Items are sent in batches of 5 so each request stays
 * small and one failing batch never sinks the whole analysis.
 */

/** One line handed to the AI, pre-grounded by the deterministic engine + KB. */
export interface AiEnrichInputItem {
  name: string;
  uctzedCode: string | null;
  codeConfidence: string | null;
  dutyRatePercent: number | null;
  dutyRateSource: string;
  /** KB origin (product_origin_kb) — applied BEFORE the AI; blocks overwrite downstream. */
  originType: string | null;
  recommendedOrigin: string | null;
  category: string;
  precursorNote: string | null;
}

export interface AiEnrichment {
  /** AiItem keyed by normalize(name) for a stable join back to the rows. */
  byName: Map<string, AiItem>;
  criticalAlert: string;
  nctsList: string[];
  /** true when at least one batch failed → caller forces needsReview on unenriched rows. */
  degraded: boolean;
}

const BATCH_SIZE = 5;
const MAX_TOKENS = 8000;

// ── Офіційні HS-описи (для CONTEXT) ──────────────────────────────────
import { HS_DESC } from './data/index.js';
function hsDesc(code?: string | null): string | null {
  const d = String(code ?? '').replace(/\D/g, '');
  if (d.length < 2) return null;
  return HS_DESC[d.slice(0, 6)] ?? HS_DESC[d.slice(0, 4)] ?? HS_DESC[d.slice(0, 2)] ?? null;
}

// ── RAG-контекст (порт lib/ai/rag.ts): релевантні теми рулбуку у CONTEXT ──
interface RagSignals {
  blob: string;
  chapters: Set<string>;
  hasPrecursor: boolean;
}
function signalsFromItems(items: AiEnrichInputItem[]): RagSignals {
  const parts: string[] = [];
  const chapters = new Set<string>();
  let hasPrecursor = false;
  for (const it of items) {
    parts.push(it.name ?? '', it.category ?? '', it.originType ?? '');
    if (it.precursorNote) hasPrecursor = true;
    const d = String(it.uctzedCode ?? '').replace(/\D/g, '');
    if (d.length >= 2) chapters.add(d.slice(0, 2));
  }
  return { blob: parts.join(' ').toLowerCase(), chapters, hasPrecursor };
}
const hasRx = (blob: string, rx: RegExp): boolean => rx.test(blob);
const anyChapter = (chapters: Set<string>, list: string[]): boolean => list.some((c) => chapters.has(c));

interface Selector {
  rx: RegExp;
  when: (s: RagSignals) => boolean;
}
const SELECTORS: Selector[] = [
  { rx: /Транзит ЄС/i, when: () => true },
  { rx: /Митниця України/i, when: () => true },
  { rx: /Ключові документи/i, when: () => true },
  {
    rx: /Фармацевтика/i,
    when: (s) => hasRx(s.blob, /фарм|аф[іи]|\bapi\b|антибіотик|ліки|субстанц|excipient|допоміжн/i) || anyChapter(s.chapters, ['30', '29']),
  },
  { rx: /GMP · EudraLex/i, when: (s) => hasRx(s.blob, /фарм|аф[іи]|\bapi\b|gmp|антибіотик|субстанц/i) },
  {
    rx: /REACH · CLP/i,
    when: (s) => hasRx(s.blob, /хім|chemical|кислот|реактив|розчинник|полімер|барвник|пігмент/i) || anyChapter(s.chapters, ['28', '32', '34', '38', '39']),
  },
  { rx: /Прекурсори/i, when: (s) => s.hasPrecursor || hasRx(s.blob, /прекурсор|подвійн|dual.?use|ефедрин|псевдоефедрин/i) },
  { rx: /Санкції/i, when: (s) => hasRx(s.blob, /санкц|dual.?use|подвійн|export control|подвійного призначення/i) },
  { rx: /Холодовий ланцюг/i, when: (s) => hasRx(s.blob, /температур|cold|gdp|reefer|вакцин|біолог|інсулін|фермент|пробіотик|термолабіл/i) },
];
function selectTopics(s: RagSignals, maxTopics = 6): ZedTopic[] {
  const picked: ZedTopic[] = [];
  const seen = new Set<string>();
  for (const sel of SELECTORS) {
    if (!sel.when(s)) continue;
    const topic = ZED_TOPICS.find((t) => sel.rx.test(t.topic));
    if (topic && !seen.has(topic.topic)) {
      seen.add(topic.topic);
      picked.push(topic);
      if (picked.length >= maxTopics) break;
    }
  }
  return picked;
}
function renderRagContext(topics: ZedTopic[], budget = 12000): string {
  const out: string[] = [];
  let used = 0;
  const push = (line: string): boolean => {
    if (used + line.length > budget) return false;
    out.push(line);
    used += line.length + 1;
    return true;
  };
  for (const t of topics) {
    if (!push(`## ${t.ico} ${t.topic} — ${t.short}`)) break;
    for (const sec of t.sections ?? []) {
      if (!push(`### ${sec.title}`)) break;
      for (const row of sec.rows ?? []) {
        const label = String(row[0] ?? '').trim();
        const detail = String(row[1] ?? '').trim().slice(0, 200);
        if (!label && !detail) continue;
        if (!push(`- ${label}: ${detail}`)) break;
      }
    }
  }
  return out.join('\n');
}
function buildRagContext(items: AiEnrichInputItem[]): string {
  return renderRagContext(selectTopics(signalsFromItems(items)));
}

// ── Промпт (порт lib/ai/prompt.ts) ────────────────────────────────────
function buildSystemPrompt(tariffFacts: string, ragContext: string): string {
  const today = new Date().toLocaleDateString('uk-UA', { year: 'numeric', month: 'long', day: 'numeric' });
  return `Ти — аналітик з митного оформлення та логістики для збірних вантажів фарм/хім-продукції (Китай/Індія → Україна транзитом через ЄС). Працюєш для ЛОГІСТА та МИТНОГО БРОКЕРА.

ПОТОЧНА ДАТА АНАЛІЗУ: ${today}

ЖОРСТКІ ПРАВИЛА:
1. Використовуй ТІЛЬКИ факти з блоку CONTEXT нижче. Якщо факту немає в CONTEXT — постав поле в null і needsReview=true. НЕ вигадуй норми, коди чи ставки з пам'яті.
2. НЕ рахуй гроші: мито, ПДВ, митну вартість рахує окремий детермінований движок. Ти повертаєш лише описові/класифікаційні поля.
3. Кількість і ціну бери як є з таблиці; не змінюй і не додавай позиції, яких немає у вхідних даних.
4. Код УКТЗЕД можеш ЗАПРОПОНУВАТИ (suggestedUctzedCode) — його окремо перевірить система за тарифом. Якщо не впевнений — null.
5. euChecks/uaChecks мають бути практичними діями для брокера (NCTS/T1, MRN, ICS2, CMR/BL, packing list, seal, BCP/TRACES, фіто/вет, ДПСС, ADR/SDS, температурний режим), і спиратись на CONTEXT.
6. Відповідь — суворий JSON за схемою, без markdown.

=== CONTEXT: ТАРИФНІ ФАКТИ ===
${tariffFacts || '(немає)'}

=== CONTEXT: НОРМИ ТА ДОКУМЕНТИ (RAG — експертний рулбук) ===
${ragContext || '(порожньо — став needsReview=true для будь-яких нормативних тверджень)'}

Спирайся на цей рулбук для euChecks/uaChecks. Якщо конкретної норми для позиції в рулбуку НЕМАЄ — не вигадуй її: постав needsReview=true і сформулюй перевірку як «уточнити …».`;
}

function buildTariffFacts(items: AiEnrichInputItem[]): string {
  return items
    .map((it, i) => {
      const lines = [
        `${i + 1}. ${it.name}`,
        `   УКТЗЕД: ${it.uctzedCode ?? 'не визначено'} (джерело: ${it.dutyRateSource ?? '—'}, впевненість коду: ${it.codeConfidence ?? '—'})`,
        ...(hsDesc(it.uctzedCode) ? [`   HS (офіц. WCO): ${hsDesc(it.uctzedCode)}`] : []),
        `   Ставка мита: ${it.dutyRatePercent ?? '?'}%`,
        `   Походження (попередньо): ${it.originType ?? '—'}${it.recommendedOrigin ? `; рекомендований тип: ${it.recommendedOrigin}` : ''}${it.category ? `; категорія: ${it.category}` : ''}`,
      ];
      if (it.precursorNote) lines.push(`   УВАГА (прекурсор/контроль): ${it.precursorNote}`);
      return lines.join('\n');
    })
    .join('\n');
}

function buildUserPrompt(items: AiEnrichInputItem[]): string {
  const list = items.map((it, i) => `${i + 1}. ${it.name}`).join('\n');
  return `Проаналізуй позиції нижче з погляду ЛОГІСТА та МИТНОГО БРОКЕРА.
Для КОЖНОЇ позиції поверни:
- euChecks[]: практичні перевірки транзиту через ЄС (NCTS/T1, MRN, ICS2/ENS, CMR/AWB/BL, packing list, seal, gross/net, BCP/TRACES, фіто/вет, ADR/SDS, температурний режим);
- uaChecks[]: перевірки розмитнення в Україні (ДПСС, фіто/вет, митна лабораторія, код/опис, документи, платежі, температурний режим);
- originType, productionMethod, originShortNote, category, applications, hazardAnalysis, storageRequirements;
- risk ("Критичний"/"Середній"/"Низький") + riskNote; needsReview.
Кожна перевірка: {item, status: "green"|"yellow"|"red", note}. Спирайся на CONTEXT вище; НЕ рахуй гроші; НЕ додавай позицій, яких немає у списку.
Якщо впевненість коду низька або код не визначено — став needsReview=true і додай перевірку класифікації/лабораторної ідентифікації. Не дублюй те, що вже випливає з рекомендованого типу походження — додавай перевірки, специфічні саме для цього товару, маршруту й документів.

СПИСОК ПОЗИЦІЙ:
${list}

Поверни строгий JSON: { "items": [ ... ], "criticalAlert": "", "nctsList": [] }.`;
}

/** Виймає JSON навіть якщо модель обгорнула у markdown. */
function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('Не вдалося розібрати JSON-відповідь AI.');
  }
}

async function callModel(system: string, user: string, ownerId?: string): Promise<string> {
  // Built-in Claude by default; BYOK provider when the owner configured one. The
  // proxy appends the JSON nudge for built-in, so pass the raw user prompt here.
  return callAnalysisAi(ownerId, { system, user, maxTokens: MAX_TOKENS });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function enrichWithAi(
  items: AiEnrichInputItem[],
  ownerId?: string,
): Promise<AiEnrichment> {
  const byName = new Map<string, AiItem>();
  let criticalAlert = '';
  const nctsSet = new Set<string>();
  let degraded = false;

  if (items.length === 0) {
    return { byName, criticalAlert, nctsList: [], degraded };
  }

  for (const batch of chunk(items, BATCH_SIZE)) {
    try {
      const system = buildSystemPrompt(buildTariffFacts(batch), buildRagContext(batch));
      const raw = await callModel(system, buildUserPrompt(batch), ownerId);
      const parsed = AiResponse.parse(extractJson(raw));
      for (const it of parsed.items) byName.set(normalize(it.name), it);
      if (!criticalAlert && parsed.criticalAlert) criticalAlert = parsed.criticalAlert;
      for (const n of parsed.nctsList) nctsSet.add(n);
    } catch {
      // Degrade gracefully: this batch stays deterministic-only. The caller
      // forces needsReview on any row without an AI item. Never crash.
      degraded = true;
    }
  }

  return { byName, criticalAlert, nctsList: [...nctsSet], degraded };
}
