/**
 * Движок можливого походження — порт з index.html:
 *  inferOriginCandidateKeys (@9966), originProfileByKey (@9817), chooseRecommendedOriginKey (@10040).
 * Детермінований: за главою/позицією УКТЗЕД + ключовими словами формує кандидатів походження,
 * кожен з власними перевірками ЄС/UA/транзит. Вибір походження «перебудовує» перевірки.
 */

export type OriginKey = 'plant' | 'animal' | 'fermentation' | 'mineral' | 'synthetic' | 'mixed' | 'unknown';

export interface OriginCheck { item: string; status: 'red' | 'yellow' | 'green'; note: string }

export interface OriginProfile {
  key: OriginKey;
  label: string;
  shortLabel: string;
  confidence: 'high' | 'medium' | 'low';
  basis: string;
  euChecks: OriginCheck[];
  uaChecks: OriginCheck[];
  transitChecks: OriginCheck[];
  recommended?: boolean;
}

export interface OriginItem {
  name?: string;
  uctzedCode?: string | null;
  category?: string;
  applications?: string;
  originType?: string | null;
  productionMethod?: string | null;
  originShortNote?: string;
}

const c = (item: string, status: 'red' | 'yellow' | 'green', note: string): OriginCheck => ({ item, status, note });

export function normalizeHsCode(value?: string | null): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 10);
}

export function buildQdProGoodInfoUrl(code?: string | null): string {
  const d = normalizeHsCode(code);
  return d ? `https://www.qdpro.com.ua/uk/goodinfo/${d}` : 'https://www.qdpro.com.ua/uk/goodinfo';
}

const PROFILES: Record<OriginKey, Omit<OriginProfile, 'recommended'>> = {
  synthetic: {
    key: 'synthetic', label: 'Синтетичне / нафтохімічне / органічний синтез', shortLabel: 'Синтетичне', confidence: 'medium',
    basis: 'Для синтетичного або нафтохімічного походження потрібні CoA, SDS/TDS, CAS і підтвердження виробника щодо manufacturing route/source.',
    euChecks: [
      c('Синтетичне/нафтохімічне: SDS/CLP/ADR', 'yellow', 'Перевірити hazard class, CLP pictograms, UN number і умови перевезення за SDS.'),
      c('Синтетичне/нафтохімічне: REACH/обмеження', 'yellow', 'Перевірити, чи немає Annex XVII/SVHC/precursor нюансів за речовиною й застосуванням.'),
      c('Синтетичне: CoA/TDS', 'green', 'Підготувати CoA, TDS/specification, CAS, assay і impurities.'),
    ],
    uaChecks: [
      c('Синтетичне: митна лабораторія', 'yellow', 'Можливий відбір проб для підтвердження речовини, концентрації, CAS і коду УКТЗЕД.'),
      c('Синтетичне: SDS українською/англійською', 'yellow', 'SDS має бути повним і узгодженим з маркуванням.'),
      c('Синтетичне: стандартний пакет', 'green', 'Invoice, PL, CoA, SDS/TDS, контракт і транспортні документи.'),
    ],
    transitChecks: [
      c('Синтетика: сумісність у збірному вантажі', 'yellow', 'Перевірити несумісність з кислотами/лугами/окисниками, температурний режим і вентиляцію.'),
      c('Синтетика: HS/CAS matching', 'yellow', 'CAS, назва, концентрація й код у документах не мають конфліктувати.'),
      c('Синтетика: non-DG statement', 'green', 'Якщо не ADR — отримати підтвердження non-dangerous cargo для перевізника.'),
    ],
  },
  fermentation: {
    key: 'fermentation', label: 'Ферментаційне / біотехнологічне', shortLabel: 'Ферментаційне', confidence: 'medium',
    basis: 'Ферментаційне походження підтверджується CoA, описом виробничого штаму/носія, GMO/non-GMO за потреби.',
    euChecks: [
      c('Ферментація: strain/GMO', 'yellow', 'Перевірити штам, носій, GMO/non-GMO, allergen і food/feed/pharma статус.'),
      c('Ферментація: microbiology', 'yellow', 'Мікробіологічні показники, activity/assay, endotoxin/bioburden якщо релевантно.'),
      c('Ферментація: temperature', 'yellow', 'Перевірити температурний режим і термін придатності.'),
    ],
    uaChecks: [
      c('Ферментація: призначення товару', 'yellow', 'Режим контролю залежить від food/feed/pharma/vet призначення.'),
      c('Ферментація: CoA/активність', 'yellow', 'CoA має містити активність/assay, мікробіологію, вологість і batch.'),
      c('Ферментація: ДПСС/фарм контроль', 'yellow', 'Для кормового/ветеринарного/фарм-використання можливий додатковий контроль.'),
    ],
    transitChecks: [
      c('Біотех: data logger', 'yellow', 'Якщо є температурний режим — погодити data logger і допустимі excursions.'),
      c('Біотех: не змішувати з odor cargo', 'yellow', 'Уникати сусідства з пахучими, токсичними або пиловими товарами.'),
      c('Біотех: lot traceability', 'green', 'Batch/lot у всіх документах має збігатися.'),
    ],
  },
  plant: {
    key: 'plant', label: 'Рослинне / ботанічне', shortLabel: 'Рослинне', confidence: 'high',
    basis: 'Рослинне походження перевіряється за латинською назвою, частиною рослини, країною збору й phytosanitary documents.',
    euChecks: [
      c('Рослинне: phytosanitary', 'red', 'Перевірити фітосанітарний сертифікат, латинську назву, частину рослини та країну походження.'),
      c('Рослинне: pesticides/MRL', 'yellow', 'Для food/pharma/herbal підготувати pesticides, heavy metals, microbiology, aflatoxins.'),
      c('Рослинне: CITES/карантин', 'yellow', 'Перевірити CITES, карантинні шкідники, деревʼяну упаковку/IPPC.'),
    ],
    uaChecks: [
      c('Рослинне: фітосанітарний сертифікат', 'red', 'Потрібна коректна форма фітосанітарного сертифіката і збіг даних з Invoice/PL.'),
      c('Рослинне: карантинний огляд', 'yellow', 'Ймовірний фізичний огляд, відбір проб, перевірка шкідників і вологості.'),
      c('Рослинне: санітарні показники', 'yellow', 'Для харчового/фарм використання — мікробіологія, пестициди, важкі метали.'),
    ],
    transitChecks: [
      c('Ботаніка: route via BCP', 'yellow', 'Погодити пункт перетину з можливим фітосанітарним контролем.'),
      c('Ботаніка: запах/вологість', 'yellow', 'Не ставити поруч з odor-sensitive сировиною; контролювати сухість і цілісність мішків.'),
      c('Ботаніка: latin name matching', 'red', 'Латинська назва, частина рослини і batch мають збігатися в усіх документах.'),
    ],
  },
  animal: {
    key: 'animal', label: 'Тваринне / біологічне', shortLabel: 'Тваринне', confidence: 'high',
    basis: 'Тваринне/біологічне походження підтверджується species/source, health/veterinary certificate, traceability.',
    euChecks: [
      c('Тваринне: vet/health certificate', 'red', 'Перевірити ветеринарний або health certificate, species/source і країну походження.'),
      c('Тваринне: TRACES/BCP', 'red', 'Для ЄС можливий контроль через Border Control Post/TRACES.'),
      c('Тваринне: TSE/BSE/traceability', 'yellow', 'Підтвердження TSE/BSE, non-human/animal source, batch traceability.'),
    ],
    uaChecks: [
      c('Тваринне: міжнародний ветсертифікат', 'red', 'Критично перевірити затверджену форму міжнародного ветеринарного сертифіката.'),
      c('Тваринне: ДПСС контроль', 'red', 'ДПСС може вимагати погодження, огляд або відбір проб.'),
      c('Тваринне: температурний режим', 'yellow', 'Для біологічного/чутливого — cold chain, упаковка, data logger.'),
    ],
    transitChecks: [
      c('Тваринне: pre-alert BCP', 'red', 'Заздалегідь погодити BCP/ветконтроль, слоти й пакет документів.'),
      c('Тваринне: segregated cargo', 'yellow', 'Не змішувати з харчовою/фарма сировиною без підтвердження сумісності.'),
      c('Тваринне: seal + temp log', 'yellow', 'Контролювати пломби, температуру, цілісність тари й час на кордоні.'),
    ],
  },
  mineral: {
    key: 'mineral', label: 'Мінеральне / неорганічне', shortLabel: 'Мінеральне', confidence: 'high',
    basis: 'Мінеральне/неорганічне походження підтверджується складом, concentration, assay, impurities і SDS.',
    euChecks: [
      c('Мінеральне: концентрація/assay', 'yellow', 'Код може залежати від концентрації, форми, чистоти та домішок; перевірити CoA.'),
      c('Мінеральне: SDS/ADR', 'yellow', 'Перевірити корозійність, токсичність, UN number, packing group і сумісність.'),
      c('Мінеральне: restrictions/precursors', 'yellow', 'Для окремих солей/кислот/лугів перевірити precursor або дозвільні обмеження.'),
    ],
    uaChecks: [
      c('Мінеральне: лабораторна ідентифікація', 'yellow', 'Можливий відбір проб на концентрацію/домішки/відповідність коду.'),
      c('Мінеральне: небезпечний вантаж', 'yellow', 'Якщо ADR — labels, UN number, інструкції й підтвердження допуску перевізника.'),
      c('Мінеральне: стандартні документи', 'green', 'Invoice, PL, CoA, SDS, TDS, контракт і транспортні документи.'),
    ],
    transitChecks: [
      c('Мінеральне: segregation', 'yellow', 'Перевірити несумісність з кислотами/лугами/окисниками та вимоги до пакування.'),
      c('Мінеральне: spill control', 'yellow', 'Для рідин/корозійних речовин погодити аварійний комплект і герметичність тари.'),
      c('Мінеральне: gross weight', 'green', 'Звірити навантаження, вагу на вісь і кількість місць.'),
    ],
  },
  mixed: {
    key: 'mixed', label: 'Змішане / багатокомпонентне', shortLabel: 'Змішане', confidence: 'medium',
    basis: 'Для сумішей або подвійного походження треба composition statement і підтвердити, яка частина визначає код.',
    euChecks: [
      c('Змішане: composition statement', 'red', 'Без складу/відсотків компонентів класифікація ненадійна.'),
      c('Змішане: dominant component', 'yellow', 'Перевірити компонент, який визначає код, небезпеку й режим контролю.'),
      c('Змішане: SDS/label consistency', 'yellow', 'SDS, label і CoA мають однаково описувати склад та hazard.'),
    ],
    uaChecks: [
      c('Змішане: митна лабораторія', 'yellow', 'Ймовірний відбір проб для підтвердження складу й коду.'),
      c('Змішане: призначення', 'yellow', 'Food/feed/pharma/cosmetic призначення змінює документи й контроль.'),
      c('Змішане: походження компонентів', 'yellow', 'Для тваринних/рослинних компонентів можливі вет/фіто вимоги.'),
    ],
    transitChecks: [
      c('Змішане: cargo compatibility', 'yellow', 'Перевірити сумісність усіх компонентів у збірному вантажі.'),
      c('Змішане: label vs SDS', 'yellow', 'Маркування, SDS і invoice description не повинні конфліктувати.'),
      c('Змішане: broker pre-check', 'red', 'Перед відправкою — попередня класифікація брокером по складу.'),
    ],
  },
  unknown: {
    key: 'unknown', label: 'Невідоме / підтвердити документами', shortLabel: 'Невідоме', confidence: 'low',
    basis: 'Автоматично підтвердити походження неможливо: потрібні CoA, SDS, TDS, виробник, origin statement.',
    euChecks: [
      c('Невідоме: origin statement', 'red', 'Запросити офіційне підтвердження походження та методу виробництва.'),
      c('Невідоме: SDS/CoA/TDS', 'yellow', 'Документи мають підтвердити CAS, склад, застосування, небезпеку і batch.'),
      c('Невідоме: broker classification', 'red', 'До бронювання транспорту — попередня перевірка коду брокером.'),
    ],
    uaChecks: [
      c('Невідоме: класифікаційне рішення', 'red', 'Без підтвердження походження/складу високий ризик запиту митниці/лабораторії.'),
      c('Невідоме: контроль за призначенням', 'yellow', 'Чітко визначити призначення: pharma/food/feed/vet/cosmetic/industrial.'),
      c('Невідоме: документи партії', 'yellow', 'CoA, SDS, Invoice, PL і маркування мають збігатися по назві, batch і виробнику.'),
    ],
    transitChecks: [
      c('Невідоме: no dispatch before pre-check', 'red', 'Не відправляти до перевірки коду, небезпеки, документів і маршруту.'),
      c('Невідоме: transport acceptance', 'yellow', 'Перевізник має підтвердити прийняття вантажу за SDS/описом.'),
      c('Невідоме: contingency time', 'yellow', 'Закласти час на запити брокера/митної лабораторії.'),
    ],
  },
};

export function originProfileByKey(key: OriginKey): Omit<OriginProfile, 'recommended'> {
  return PROFILES[key] ?? PROFILES.unknown;
}

/** Порт inferOriginCandidateKeys (@9966). */
export function inferOriginCandidateKeys(item: OriginItem): OriginKey[] {
  const hs = normalizeHsCode(item.uctzedCode);
  const ch = hs.slice(0, 2);
  const heading = hs.slice(0, 4);
  const text = [item.name, item.category, item.applications, item.originType, item.productionMethod, item.originShortNote]
    .filter(Boolean).join(' ').toLowerCase();
  const keys = new Set<OriginKey>();
  const add = (...arr: OriginKey[]) => arr.forEach((k) => keys.add(k));
  const has = (re: RegExp) => re.test(text);

  if (has(/рослин|растител|plant|botanic|botanical|herb|herbal|extract|екстракт|камед|gum\b|смол|resin|олія|масло|essential oil|leaf|root|flower|seed|wood|дерев|целюл|cellulose|starch|крохмал|pectin|пектин|alginate|альгін|каучук натураль/)) add('plant');
  if (has(/тварин|животн|animal|bovine|porcine|fish|marine|gelatin|желатин|lanolin|wool|silk|casein|albumin|collagen|казеїн|альбумін|колаген|молоч|dairy|honey|мед|перли|pearls/)) add('animal');
  if (has(/ferment|фермент|fermentation|enzyme|ензим|біотех|biotech|biosynthesis|штам|strain|microbial|мікроб|бактер|yeast|дріждж|antibiotic|антибіотик|vitamin|вітамін/)) add('fermentation');
  if (has(/mineral|мінерал|минерал|inorganic|неорган|salt|сіль|соль|oxide|оксид|hydroxide|гідроксид|гидроксид|acid|кислота|луг|ore|руда|metal|метал|cement|glass|ceramic|керамік/)) add('mineral');
  if (has(/synthetic|synthesis|синтет|синтез|semi\s*synthetic|напівсинт|полусинт|chemical modified|хімічн|химическ|polymer|полімер|plastic|пластмас|petro|нафто|petroleum|silicone|силікон|rubber synthetic/)) add('synthetic');
  if (has(/mixture|blend|solution|compound|preparation|смесь|суміш|композиція|комплекс|готов|виріб|product|formulation|компонент|склад/)) add('mixed');

  if (/^(01|02|03|04|05)$/.test(ch)) add('animal');
  if (/^(06|07|08|09|10|11|12|13|14)$/.test(ch)) add('plant');
  if (ch === '15') { if (/^150[1-6]/.test(heading)) add('animal'); else if (/^151[0-5]/.test(heading)) add('plant'); else add('plant', 'animal', 'mixed'); add('fermentation'); }
  if (ch === '16') add('animal', 'mixed');
  if (/^(17|18|20|24)$/.test(ch)) add('plant', 'mixed');
  if (ch === '19') add('plant', 'animal', 'mixed');
  if (ch === '21') add('plant', 'animal', 'fermentation', 'mixed');
  if (ch === '22') add('plant', 'fermentation', 'mixed');
  if (ch === '23') add('plant', 'animal', 'mineral', 'fermentation', 'mixed');
  if (/^(25|26)$/.test(ch)) add('mineral');
  if (ch === '27') add('mineral', 'synthetic');
  if (ch === '28') add('mineral', 'synthetic');
  if (ch === '29') { add('synthetic'); if (/^(2922|2936|2941|2942)$/.test(heading)) add('fermentation'); if (/^(2936|2937)$/.test(heading)) add('animal'); if (/^(2932|2938|2939)$/.test(heading)) add('plant'); }
  if (ch === '30') { add('synthetic', 'mixed'); if (/^(3001|3002|3006)$/.test(heading)) add('animal', 'fermentation'); }
  if (ch === '31') add('mineral', 'synthetic', 'plant', 'animal', 'mixed');
  if (ch === '32') add('plant', 'mineral', 'synthetic', 'mixed');
  if (ch === '33') add('plant', 'animal', 'synthetic', 'mixed');
  if (ch === '34') add('synthetic', 'plant', 'animal', 'mineral', 'mixed');
  if (ch === '35') { if (/^(3501|3502|3503|3504)$/.test(heading)) add('animal'); if (heading === '3505') add('plant', 'synthetic'); if (heading === '3507') add('fermentation'); add('plant', 'animal', 'fermentation', 'mixed'); }
  if (/^(36|37)$/.test(ch)) add('synthetic', 'mixed');
  if (ch === '38') add('synthetic', 'mineral', 'plant', 'animal', 'fermentation', 'mixed');
  if (ch === '39') { add('synthetic'); if (heading === '3913') add('plant', 'animal', 'fermentation', 'mixed'); }
  if (ch === '40') { if (heading === '4001') add('plant'); else if (heading === '4002') add('synthetic'); else add('plant', 'synthetic', 'mixed'); }
  if (/^(41|42|43)$/.test(ch)) add('animal', 'mixed');
  if (/^(44|45|46|47|48)$/.test(ch)) add('plant', 'mixed');
  if (ch === '49') add('plant', 'mixed');
  if (/^(50|51)$/.test(ch)) add('animal');
  if (/^(52|53)$/.test(ch)) add('plant');
  if (/^(54|55)$/.test(ch)) add('synthetic');
  if (/^(56|57|58|59|60|61|62|63|64|65|66|67)$/.test(ch)) add('animal', 'plant', 'synthetic', 'mixed');
  if (/^(68|69|70|72|73|74|75|76|78|79|80|81|82|83)$/.test(ch)) add('mineral', 'mixed');
  if (ch === '71') add('mineral', 'animal', 'synthetic', 'mixed');
  if (/^(84|85|86|87|88|89|90|91|92|94|95|96|97)$/.test(ch)) add('synthetic', 'mineral', 'plant', 'animal', 'mixed');

  if (item.originType && item.originType !== 'Не визначено') {
    const p = String(item.originType).toLowerCase();
    if (/рослин|ботан|plant/.test(p)) add('plant');
    if (/тварин|animal|біо|bio/.test(p)) add('animal');
    if (/фермент|біотех|ferment|enzyme/.test(p)) add('fermentation');
    if (/мінерал|неорган|mineral|inorganic/.test(p)) add('mineral');
    if (/синтет|organic|орган|petro|нафт/.test(p)) add('synthetic');
    if (/зміш|mixed|суміш/.test(p)) add('mixed');
  }

  const ambiguous = ['15', '19', '21', '22', '23', '29', '30', '31', '32', '33', '34', '35', '38', '39', '40', '56', '57', '58', '59', '60', '61', '62', '63', '64', '65', '66', '67', '71', '84', '85', '90', '92', '94', '95', '96', '97'];
  if (!hs || keys.size === 0 || ambiguous.includes(ch)) add('unknown');

  const order: OriginKey[] = ['plant', 'animal', 'fermentation', 'mineral', 'synthetic', 'mixed', 'unknown'];
  return order.filter((k) => keys.has(k));
}

function chooseRecommended(item: OriginItem, options: OriginProfile[]): OriginKey {
  const text = [item.originType, item.productionMethod, item.originShortNote].filter(Boolean).join(' ').toLowerCase();
  const map: [OriginKey, RegExp][] = [
    ['plant', /рослин|ботан|plant|botanic|herb|extract|екстракт|starch|cellulose|pectin|alginate/],
    ['animal', /тварин|animal|біо|bio|gelatin|желатин|lanolin|bovine|porcine|casein|albumin|collagen/],
    ['fermentation', /фермент|біотех|ferment|enzyme|strain|штам|microbial|antibiotic|антибіотик/],
    ['mineral', /мінерал|неорган|mineral|inorganic|metal|oxide|hydroxide|salt|ore/],
    ['synthetic', /синтет|organic|орган|synthesis|petro|нафто|chemical modified|polymer|silicone/],
    ['mixed', /зміш|mixed|суміш|blend|mixture|preparation|formulation/],
  ];
  for (const [key, re] of map) if (re.test(text) && options.some((o) => o.key === key)) return key;
  const firstNon = options.find((o) => o.key !== 'unknown');
  return (firstNon ?? options[0] ?? { key: 'unknown' as OriginKey }).key;
}

/** Перевірки за призначенням/категорією товару (детерміновано, з бази категорій). */
export function categoryChecks(category?: string | null): { eu: OriginCheck[]; ua: OriginCheck[] } {
  const cat = String(category ?? '').toLowerCase();
  const eu: OriginCheck[] = [];
  const ua: OriginCheck[] = [];
  if (/подвійн|двойн|dual/.test(cat)) {
    eu.push(c('Подвійне призначення: export control', 'red', 'Перевірити dual-use (Reg. 2021/821), Annex I та end-use/end-user перед транзитом.'));
    ua.push(c('Подвійне призначення: Держекспортконтроль', 'red', 'Можливий дозвіл ДСЕК; підтвердити кінцеве використання й кінцевого споживача.'));
  }
  if (/афі|\bapi\b|фармац|активн\w* субстан|діюч\w* речовин/.test(cat)) {
    eu.push(c('АФІ: GMP/письмове підтвердження', 'yellow', 'Підготувати GMP (EU/PIC-S/WHO), CoA, DMF/CEP за потреби.'));
    ua.push(c('АФІ: Держлікслужба', 'red', 'Ліцензія імпортера + разовий дозвіл на ввезення (ЛЗ-2), реєстраційний контекст.'));
  }
  if (/корм|feed|ветерин/.test(cat)) {
    ua.push(c('Кормове/вет: ДПСС', 'yellow', 'Держпродспоживслужба: реєстрація кормової добавки, вет-контроль за потреби.'));
  }
  if (/харчов|food|добавк|дієтич/.test(cat)) {
    ua.push(c('Харчове: санітарні показники', 'yellow', 'Мікробіологія, важкі метали, пестициди; відповідність харчовому регламенту.'));
  }
  if (/космет|cosmet/.test(cat)) {
    eu.push(c('Косметика: CPNP / Reg. 1223', 'yellow', 'Перевірити Reg. 1223/2009, заборонені інгредієнти, маркування, CPNP-нотифікацію.'));
  }
  return { eu, ua };
}

/** Тип походження з бази (текст) → ключ картки. */
export function originKeyFromType(t?: string | null): OriginKey | null {
  const p = String(t ?? '').toLowerCase();
  if (/рослин|ботан|plant/.test(p)) return 'plant';
  if (/тварин|animal|біолог|bio/.test(p)) return 'animal';
  if (/фермент|біотех|ferment|enzyme/.test(p)) return 'fermentation';
  if (/мінерал|неорган|mineral|inorganic/.test(p)) return 'mineral';
  if (/синтет|synthetic|орган|нафто|petro/.test(p)) return 'synthetic';
  if (/зміш|mixed|суміш/.test(p)) return 'mixed';
  return null;
}

export interface OriginPin { key: OriginKey; confidence: 'high' | 'medium' | 'low' }

export function buildOriginOptions(item: OriginItem, pinned?: OriginPin | null): OriginProfile[] {
  const keys = inferOriginCandidateKeys(item);
  // Якщо база впевнено визначила походження — гарантуємо його присутність першим.
  if (pinned && !keys.includes(pinned.key)) keys.unshift(pinned.key);
  const options = keys.map((k) => ({ ...originProfileByKey(k) }));
  const recKey = pinned?.key ?? chooseRecommended(item, options);
  return options.map((o) => ({
    ...o,
    recommended: o.key === recKey,
    confidence: pinned && o.key === pinned.key ? pinned.confidence : o.confidence,
  }));
}
