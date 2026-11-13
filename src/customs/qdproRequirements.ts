import type { UktzedLookupResult } from './logist/index.js';
import { VET_SQL_RX } from '../reconciliation/feed.js';

/**
 * Documents an УКТ ЗЕД code requires on IMPORT, read from the official qdpro
 * goodinfo page (its ІМПОРТ regime tab). PURE: no network, no database — the
 * cache (`hsRequirementsCache.ts`) fetches and stores, the verdicts read the
 * cache. Conservative by design: a measure maps to a requirement only when the
 * text clearly names it and does not negate it; anything unknown is ignored.
 */

export type HsRequirementKey =
  | 'veterinary_certificate'
  | 'phytosanitary_certificate'
  | 'import_license'
  | 'precursor_permit'
  | 'conformity_document'
  | 'dual_use_permit';

export const HS_REQUIREMENT_KEYS: readonly HsRequirementKey[] = [
  'veterinary_certificate',
  'phytosanitary_certificate',
  'import_license',
  'precursor_permit',
  'conformity_document',
  'dual_use_permit',
];

/** One requirement with the qdpro line it was read from (for the agent's explanation). */
export interface HsRequirement {
  key: HsRequirementKey;
  evidence: string;
  /**
   * The measure binds only some goods of the code — it offers a «no such goods»
   * statement (5069), is a risk-profile check (техрегламент 5123), or is limited
   * to a use («що використовуються у ветеринарній медицині»). Never a «missing»
   * document by itself.
   */
  conditional?: string;
  /** Parser revision that produced the entry; older cache rows are re-fetched. */
  rev?: number;
}

/** Bump when the parser changes what counts as a requirement. */
export const QDPRO_PARSER_REV = 2;

interface Measure {
  key: HsRequirementKey;
  rx: RegExp;
  /** A line that matches this is about something else (e.g. export licensing). */
  except?: RegExp;
}

const MEASURES: Measure[] = [
  { key: 'veterinary_certificate', rx: /ветеринарн/i },
  { key: 'phytosanitary_certificate', rx: /фітосанітарн/i },
  {
    key: 'import_license',
    rx: /ліцензуванн|ліцензі[яїюй]\S*\s+(на\s+)?(імпорт|ввезенн)|імпортн\S*\s+ліценз/i,
    except: /експорт/i,
  },
  { key: 'precursor_permit', rx: /прекурсор|наркотичн|психотропн/i },
  {
    key: 'conformity_document',
    rx: /технічн\S*\s+регламент|оцінк\S*\s+відповідності|сертифікат\S*\s+відповідності|декларац\S*\s+(про\s+)?відповідності/i,
  },
  { key: 'dual_use_permit', rx: /подвійного\s+(використання|призначення)/i },
];

// "не підлягає / не потребує / не застосовується …", "звільнено", "відсутні".
// JS `\b` is ASCII-only, so the word edge before «не» is spelled out.
const NEGATION_RX =
  /(^|[^а-яіїєґa-z])не\s+(підляга|потребу|застосов|вимага|потрібн|передбачен|здійсню|поширю|вказано|зазначено)|звільнен|відсутн|^(немає|ні|—|-)\.?$/i;

// A numbered measure heading of the goodinfo page: «13. Ветеринарно-санітарний
// контроль», «- **12. Наркотичні засоби…**».
const HEADING_RX = /^(?:[-*]\s*)?(?:\*\*)?\s*\d{1,2}\.\s+\S/;
// A block that only mentions a measure word in passing (laboratory sampling:
// «субстанції фармацевтичні та ветеринарні»).
const NOT_A_MEASURE_RX = /відбор\S*\s+проб|нормативи\s+відбору/i;

/** Why a measure of this block binds only some goods, or null when it binds all. */
function conditionOf(key: HsRequirementKey, block: string): string | null {
  if (key === 'precursor_permit' && /5069|про\s+відсутність/i.test(block)) {
    return 'дозвіл лише для речовин із переліку ПКМУ № 770; для інших — заява декларанта 5069 в МД';
  }
  if (key === 'conformity_document' && /5123|нехарчов|профіл\S*\s+ризику/i.test(block)) {
    return 'ринковий нагляд за техрегламентами: перевірка за профілем ризику, не обовʼязковий документ';
  }
  if (key === 'veterinary_certificate' && /(у|для)\s+ветеринарн\S*\s+медицин|для\s+ветеринарі|тваринництв/i.test(block)) {
    return 'лише для товару ветеринарного / тваринницького призначення';
  }
  return null;
}

const EVIDENCE_MAX = 200;

/**
 * IMPORT-regime measures → requirement keys, each with its evidence line. A
 * measure counts when its line names it and neither that line nor the next one
 * (qdpro puts a heading and its value on separate lines) negates it.
 */
export function qdproMeasures(importSection: string): HsRequirement[] {
  const lines = importSection
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
  // Each line's block: from its numbered heading to the next one (a page
  // without numbered headings is one block).
  const blockStart: number[] = [];
  let start = 0;
  lines.forEach((l, i) => {
    if (HEADING_RX.test(l)) start = i;
    blockStart.push(start);
  });
  const blockText = (i: number): string => {
    const from = blockStart[i]!;
    let to = from + 1;
    while (to < lines.length && blockStart[to] === from) to++;
    return lines.slice(from, to).join('\n');
  };
  const out: HsRequirement[] = [];
  const seen = new Set<HsRequirementKey>();
  lines.forEach((line, i) => {
    for (const m of MEASURES) {
      if (seen.has(m.key) || !m.rx.test(line)) continue;
      if (m.except?.test(line)) continue;
      const next = lines[i + 1] ?? '';
      if (NEGATION_RX.test(line) || NEGATION_RX.test(next)) continue;
      // A word inside another measure's block (the sampling note) is no measure.
      if (NOT_A_MEASURE_RX.test(lines[blockStart[i]!]!)) continue;
      seen.add(m.key);
      const condition = conditionOf(m.key, blockText(i));
      out.push({
        key: m.key,
        evidence: line.length > EVIDENCE_MAX ? `${line.slice(0, EVIDENCE_MAX - 1)}…` : line,
        ...(condition ? { conditional: condition } : {}),
        rev: QDPRO_PARSER_REV,
      });
    }
  });
  // Stable order, independent of where each measure sits on the page.
  return out.sort((a, b) => HS_REQUIREMENT_KEYS.indexOf(a.key) - HS_REQUIREMENT_KEYS.indexOf(b.key));
}

/** The requirement keys the IMPORT regime of a qdpro page states for EVERY good of the code. */
export function requirementsFromQdpro(importSection: string): HsRequirementKey[] {
  return qdproMeasures(importSection).filter((m) => !m.conditional).map((m) => m.key);
}

/**
 * The ІМПОРТ regime text of a lookup: the tab labelled «ІМПОРТ…», else the
 * «## РЕЖИМ: ІМПОРТ» section of a regime-labelled text. '' when the page has no
 * import regime — never the mixed common/export text (it would mis-attribute).
 */
export function importSectionOf(r: Pick<UktzedLookupResult, 'tabs' | 'text'>): string {
  const tab = (r.tabs ?? []).find((t) => /^\s*імпорт/i.test(t.label));
  if (tab) return tab.text ?? '';
  const text = r.text ?? '';
  const m = /^##\s*РЕЖИМ:\s*ІМПОРТ[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(text);
  return m?.[1] ?? '';
}

/** A 10-digit УКТ ЗЕД code (spaces/dots dropped), or null for anything else. */
export function normalizeHsCode(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const digits = String(v).replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

/** Every 10-digit code in one extraction: `hs_code` and `line_items[].hs_code`. */
export function hsCodesOf(fields: Record<string, unknown> | null | undefined): string[] {
  if (!fields) return [];
  const out = new Set<string>();
  const top = normalizeHsCode(fields.hs_code);
  if (top) out.add(top);
  if (Array.isArray(fields.line_items)) {
    for (const li of fields.line_items as unknown[]) {
      if (li && typeof li === 'object') {
        const c = normalizeHsCode((li as Record<string, unknown>).hs_code);
        if (c) out.add(c);
      }
    }
  }
  return [...out];
}

/**
 * Postgres regexes (`~*`) over a file's Markdown sections: the file reads as the
 * document that satisfies the requirement. Evaluated in the snapshot queries.
 */
export const REQUIREMENT_FILE_SQL_RX: Record<HsRequirementKey, string> = {
  veterinary_certificate: VET_SQL_RX,
  phytosanitary_certificate: 'phytosanitary|фітосанітарн',
  import_license: 'import licen[cs]e|licen[cs]e (for|to) import|ліцензі[яїюй]\\S* на (імпорт|ввезення)|імпортн\\S* ліценз',
  precursor_permit:
    'дозв[іо]л\\S*[^.]{0,60}(прекурсор|наркотичн|психотропн)|(precursor|narcotic|psychotropic)[^.]{0,40}(permit|licen[cs]e|authori[sz]ation)|(import|export) (permit|authori[sz]ation)[^.]{0,40}(precursor|narcotic|psychotropic)',
  conformity_document:
    'certificate of conformity|declaration of conformity|сертифікат відповідності|декларація (про )?відповідності',
  dual_use_permit:
    'держекспортконтрол|висновок[^.]{0,60}подвійн|дозв[іо]л[^.]{0,60}подвійн|dual[- ]use (licen[cs]e|permit|authori[sz]ation)',
};

/** Query parameters for `requirementHitsSql`: keys and their regexes, aligned. */
export const REQUIREMENT_RX_PARAMS: [string[], string[]] = [
  [...HS_REQUIREMENT_KEYS],
  HS_REQUIREMENT_KEYS.map((k) => REQUIREMENT_FILE_SQL_RX[k]),
];

/**
 * A select-list column `requirement_hits text[]`: the requirement keys whose
 * regex matches any section of file `f`. `$keys`/`$rxs` are the positions of
 * the two `REQUIREMENT_RX_PARAMS` arrays in the query.
 */
export function requirementHitsSql(keys: number, rxs: number): string {
  return (
    `ARRAY(SELECT r.key FROM unnest($${keys}::text[], $${rxs}::text[]) AS r(key, rx) ` +
    `WHERE EXISTS (SELECT 1 FROM document_sections ds WHERE ds.file_id = f.id AND ds.text ~* r.rx)) AS requirement_hits`
  );
}

/** Cached requirements of one code (a row of `hs_requirements`). */
export interface CachedHsRequirements {
  hs_code: string;
  requirements: HsRequirement[];
}
