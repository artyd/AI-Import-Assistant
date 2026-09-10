import { query } from '../db/pool.js';

/**
 * Drug-registry cross-check (Phase 6 — official-source verification, run OFFLINE
 * against the locally mirrored State Register of Medicinal Products, see
 * `drug_registry` + `scripts/ingest-drug-registry`). Deterministic: given the
 * registration numbers extracted from a workspace's documents, it looks each one
 * up in the local mirror and compares registry facts (validity dates, manufacturer,
 * marketing-authorization holder) against what the documents say.
 *
 * ADVISORY ONLY (grounding rule #3): findings tell the declarant WHERE to look;
 * a regulatory/customs specialist confirms. Never asserts a legal conclusion.
 */

export interface RegistryRecord {
  reg_number: string;
  product_name: string | null;
  active_substance: string | null;
  dosage_form: string | null;
  manufacturer: string | null;
  manufacturer_country: string | null;
  mah_owner: string | null;
  valid_from: string | null;
  valid_to: string | null;
  valid_unlimited: boolean;
}

export interface RegistryFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  reg_number: string;
}

const EXPIRY_SOON_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(dateStr: string, now: number): number | null {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.round((t - now) / DAY_MS);
}

/** Fuzzy company-name key: lowercase, drop legal suffixes + punctuation. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|llc|inc|gmbh|co|corp|company|pvt|private|limited|тов|ооо|пп|лтд|пат|прат)\b/g, '')
    .replace(/[^a-z0-9а-яіїєґ]/gi, '')
    .trim();
}

function namesMatch(a: string, b: string): boolean {
  const ka = normalizeName(a);
  const kb = normalizeName(b);
  if (!ka || !kb) return false;
  return ka.includes(kb) || kb.includes(ka);
}

// The register is written in Ukrainian; shipment documents are often in Latin.
// A naive name compare across scripts would false-flag almost every drug, so we
// only ASSERT a mismatch when both names use the same script; different scripts
// yield an advisory "verify" note instead (precision over noise, plan Q15).
function script(s: string): 'cyr' | 'lat' | 'mixed' {
  const c = /[а-яіїєґ]/i.test(s);
  const l = /[a-z]/i.test(s);
  if (c && !l) return 'cyr';
  if (l && !c) return 'lat';
  return 'mixed';
}
function comparable(a: string, b: string): boolean {
  const sa = script(a);
  const sb = script(b);
  return sa === 'mixed' || sb === 'mixed' || sa === sb;
}

/** Looks up one registration in the local registry mirror. */
export async function getRegistration(regNumber: string): Promise<RegistryRecord | null> {
  const norm = regNumber.toUpperCase().replace(/\s+/g, '');
  const { rows } = await query<RegistryRecord>(
    `SELECT reg_number, product_name, active_substance, dosage_form, manufacturer,
            manufacturer_country, mah_owner, valid_unlimited,
            to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
            to_char(valid_to,   'YYYY-MM-DD') AS valid_to
     FROM drug_registry
     WHERE upper(replace(reg_number, ' ', '')) = $1
     LIMIT 1`,
    [norm],
  );
  return rows[0] ?? null;
}

interface DocFields {
  file_name: string;
  fields: Record<string, unknown>;
}

function collectNames(docs: DocFields[]): string[] {
  const names: string[] = [];
  for (const d of docs) {
    for (const k of ['manufacturer', 'seller', 'buyer']) {
      const v = d.fields[k];
      if (typeof v === 'string' && v.trim()) names.push(v.trim());
    }
    const parties = d.fields.parties;
    if (Array.isArray(parties)) {
      for (const p of parties) {
        const n = (p as { name?: unknown })?.name;
        if (typeof n === 'string' && n.trim()) names.push(n.trim());
      }
    }
  }
  return names;
}

/**
 * Runs the registry cross-check for every registration number found in a
 * workspace's latest extractions. Returns advisory findings (empty when there
 * are no registration numbers, or none resolve — that itself yields an info note).
 */
export async function computeRegistryChecks(workspaceId: string): Promise<RegistryFinding[]> {
  const { rows: docs } = await query<DocFields>(
    `SELECT f.name AS file_name, de.extracted_fields AS fields
     FROM document_extractions de JOIN files f ON f.id = de.file_id
     WHERE de.workspace_id = $1 AND f.is_latest = true`,
    [workspaceId],
  );

  // Distinct registration numbers stated anywhere in the documents.
  const regNumbers = new Set<string>();
  for (const d of docs) {
    const rn = d.fields.registration_number;
    if (typeof rn === 'string' && rn.trim()) regNumbers.add(rn.trim());
  }
  if (regNumbers.size === 0) return [];

  const docManufacturers = docs
    .map((d) => d.fields.manufacturer)
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const allNames = collectNames(docs);

  const now = Date.now();
  const out: RegistryFinding[] = [];

  for (const reg of regNumbers) {
    const rec = await getRegistration(reg);
    if (!rec) {
      out.push({
        code: 'registry_not_found',
        severity: 'info',
        title: `Реєстрацію ${reg} не знайдено в локальній базі реєстру`,
        detail:
          'Номер не знайдено в локальній копії Держреєстру ліків. Перевірте вручну на drlz.com.ua ' +
          'або оновіть локальну базу (scripts/ingest-drug-registry).',
        reg_number: reg,
      });
      continue;
    }

    // Validity window (skipped for unlimited registrations — необмежений).
    if (!rec.valid_unlimited && rec.valid_to) {
      const d = daysUntil(rec.valid_to, now);
      if (d !== null && d < 0) {
        out.push({
          code: 'registry_expired',
          severity: 'error',
          title: `Реєстрація ${reg} прострочена`,
          detail: `За реєстром дійсна до ${rec.valid_to} (минуло ${-d} дн.).`,
          reg_number: reg,
        });
      } else if (d !== null && d <= EXPIRY_SOON_DAYS) {
        out.push({
          code: 'registry_expiring',
          severity: 'warning',
          title: `Реєстрація ${reg} скоро завершиться`,
          detail: `За реєстром дійсна до ${rec.valid_to} (залишилось ${d} дн.) — час ініціювати перереєстрацію.`,
          reg_number: reg,
        });
      }
    }

    // Manufacturer: registry vs documents. Assert a mismatch only within the
    // same script; across languages, surface an advisory "verify" note.
    if (rec.manufacturer && docManufacturers.length > 0) {
      const regMfr = rec.manufacturer;
      const anyMatch = docManufacturers.some((m) => namesMatch(m, regMfr));
      if (!anyMatch) {
        const anyComparable = docManufacturers.some((m) => comparable(m, regMfr));
        const docList = [...new Set(docManufacturers)].map((m) => `«${m}»`).join(', ');
        out.push(
          anyComparable
            ? {
                code: 'registry_manufacturer_mismatch',
                severity: 'warning',
                title: `Виробник у документах не збігається з реєстром (${reg})`,
                detail:
                  `Реєстр: «${regMfr}». У документах: ${docList}. ` +
                  'На митниці назва виробника має відповідати реєстру — уточніть у постачальника.',
                reg_number: reg,
              }
            : {
                code: 'registry_manufacturer_verify',
                severity: 'info',
                title: `Звірте виробника з реєстром (${reg})`,
                detail:
                  `За реєстром виробник — «${regMfr}». У документах: ${docList}. ` +
                  'Назви різними мовами — звірте, що це та сама юридична особа.',
                reg_number: reg,
              },
        );
      }
    }

    // Marketing-authorization holder present in the documents?
    if (rec.mah_owner) {
      const owner = rec.mah_owner;
      const ownerInDocs = allNames.some((n) => namesMatch(n, owner));
      if (!ownerInDocs) {
        const anyComparable = allNames.some((n) => comparable(n, owner));
        out.push(
          anyComparable
            ? {
                code: 'registry_owner_absent',
                severity: 'warning',
                title: `Власник реєстрації відсутній у документах (${reg})`,
                detail:
                  `Власник реєстраційного посвідчення за реєстром — «${owner}» — не згадується в жодному ` +
                  'документі постачання. Потрібен договір/авторизація від власника на ввезення, або уточнення сторін.',
                reg_number: reg,
              }
            : {
                code: 'registry_owner_verify',
                severity: 'info',
                title: `Звірте власника реєстрації (${reg})`,
                detail:
                  `Власник реєстраційного посвідчення за реєстром — «${owner}». Переконайтеся, що він фігурує в ` +
                  'документах (договір/авторизація на ввезення) — назви можуть бути різними мовами.',
                reg_number: reg,
              },
        );
      }
    }
  }

  return out;
}
