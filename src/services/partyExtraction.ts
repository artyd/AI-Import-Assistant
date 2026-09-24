import { query } from '../db/pool.js';
import type { PartyRole } from './parties.js';

/**
 * Deterministic party + contract-type derivation from a workspace's stored
 * document extractions. Makes NO new LLM call and NEVER guesses:
 *
 * The deal always has three roles, mapped to the three fixed slots:
 *   sender       «Хто»       — the MANUFACTURER / producer of the goods
 *   intermediary «Через кого» — the trading company that SELLS to us (e.g. Prime
 *                               Force UK) — present ONLY in a trilateral deal
 *   recipient    «Кому»       — the final consignee / importer (us)
 *
 * Bilateral vs trilateral is decided from FACTS, not a party head-count:
 *   - manufacturer == invoice seller           → BILATERAL  (maker sells direct)
 *   - manufacturer != invoice seller           → TRILATERAL (sold via a middleman)
 *   - can't compare (a side is missing)        → null, with an explicit reason
 *
 * Every suggestion carries the source files it was read from ("точечно"), so the
 * user sees exactly where each party came from and can confirm/correct.
 */

export interface PartySuggestion {
  role: PartyRole;
  company_name: string;
  country: string | null;
  source_files: string[];
  confidence: number; // 0..1, corroboration across the documents that state it
  // Which extracted field the name came from (manufacturer / seller / buyer) —
  // traceability for the UI.
  from_field: 'manufacturer' | 'seller' | 'buyer';
  // True when the role is NOT confirmed by the documents (e.g. we know the
  // invoice seller but not the manufacturer, so we can't be sure the seller is
  // the producer). The UI must show this as "роль уточнюється", never as fact.
  uncertain_role?: boolean;
}

export interface PartiesAnalysis {
  suggestions: PartySuggestion[];
  contract_type: 'bilateral' | 'trilateral' | null;
  // Human-readable, honest explanation of the contract_type decision (or why it
  // could not be made). Surfaced in the completeness tab.
  contract_type_reason: string;
}

interface ExtractionRow {
  file_name: string;
  fields: Record<string, unknown>;
}

interface Bucket {
  name: string;
  country: string | null;
  sources: Set<string>;
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Same legal entity? Exact normalized match, or one name contained in the other
 *  (handles "Prime Force UK Business Ltd" vs "Prime Force UK"). */
function sameEntity(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Free-text role labels on a structured `parties[]` entry → one of the three
// business roles we care about. Anything unrecognised is ignored (NOT defaulted
// to a slot — that would be guessing).
const MANUFACTURER_RX = /виробник|производ|manufactur|maker|made\s*by|заводвиготовлюв|producer/i;
const SELLER_RX = /продав|seller|supplier|постачальник|поставщик|exporter|експортер|shipper|вантажовідправник|грузоотправ|vendor/i;
const BUYER_RX = /покуп|buyer|consignee|вантажоодержув|грузополуч|отримувач|получатель|importer|імпортер/i;

function classifyPartyRole(role: string | null): 'manufacturer' | 'seller' | 'buyer' | null {
  if (!role) return null;
  if (MANUFACTURER_RX.test(role)) return 'manufacturer';
  if (SELLER_RX.test(role)) return 'seller';
  if (BUYER_RX.test(role)) return 'buyer';
  return null;
}

/** Most-corroborated entry in a bucket (ties → first seen). */
function pickTop(bucket: Map<string, Bucket>): Bucket | null {
  let best: Bucket | null = null;
  for (const b of bucket.values()) {
    if (!best || b.sources.size > best.sources.size) best = b;
  }
  return best;
}

/**
 * Deterministic parties + contract-type analysis from stored extractions.
 * Read-only; does not write to `parties`.
 */
export async function analyzeParties(workspaceId: string): Promise<PartiesAnalysis> {
  const { rows } = await query<ExtractionRow>(
    `SELECT f.name AS file_name, de.extracted_fields AS fields
     FROM document_extractions de JOIN files f ON f.id = de.file_id
     WHERE de.workspace_id = $1 AND f.is_latest = true`,
    [workspaceId],
  );
  const totalDocs = rows.length || 1;

  const manufacturers = new Map<string, Bucket>();
  const sellers = new Map<string, Bucket>();
  const buyers = new Map<string, Bucket>();

  const add = (
    bucket: Map<string, Bucket>,
    name: string | null,
    country: string | null,
    source: string,
  ): void => {
    if (!name) return;
    const key = norm(name);
    if (!key) return;
    const existing = bucket.get(key);
    if (existing) {
      existing.sources.add(source);
      if (!existing.country && country) existing.country = country;
    } else {
      bucket.set(key, { name, country, sources: new Set([source]) });
    }
  };

  for (const r of rows) {
    const f = r.fields ?? {};
    const src = r.file_name;
    const origin = str(f.country_of_origin);
    // Scalar fields — the primary, most reliable signal.
    add(manufacturers, str(f.manufacturer), origin, src);
    add(sellers, str(f.seller), null, src);
    add(buyers, str(f.buyer), null, src);
    // Structured parties[] — only entries whose role we can classify; unknown
    // roles are ignored rather than forced into a slot.
    const parties = Array.isArray(f.parties) ? (f.parties as Record<string, unknown>[]) : [];
    for (const p of parties) {
      const cls = classifyPartyRole(str(p.role));
      if (!cls) continue;
      const bucket = cls === 'manufacturer' ? manufacturers : cls === 'seller' ? sellers : buyers;
      add(bucket, str(p.name), str(p.country), src);
    }
  }

  return decideParties(
    pickTop(manufacturers),
    pickTop(sellers),
    pickTop(buyers),
    totalDocs,
  );
}

/**
 * The pure decision: given the top manufacturer / seller / buyer candidate (each
 * possibly null), assign the three slots and decide the contract type from FACTS.
 * Exported so the 2-/3-sided logic can be unit-tested without a database.
 */
export function decideParties(
  M: Bucket | null,
  S: Bucket | null,
  B: Bucket | null,
  totalDocs: number,
): PartiesAnalysis {
  const suggestions: PartySuggestion[] = [];
  const conf = (b: Bucket): number => Math.min(1, b.sources.size / Math.max(1, totalDocs));
  const push = (
    role: PartyRole,
    b: Bucket,
    from_field: PartySuggestion['from_field'],
    uncertain = false,
  ): void => {
    suggestions.push({
      role,
      company_name: b.name,
      country: b.country,
      source_files: [...b.sources],
      confidence: conf(b),
      from_field,
      ...(uncertain ? { uncertain_role: true } : {}),
    });
  };

  // Recipient «Кому» — the invoice buyer, always its own role.
  if (B) push('recipient', B, 'buyer');

  let contract_type: 'bilateral' | 'trilateral' | null = null;
  let contract_type_reason: string;

  if (M && S) {
    if (sameEntity(M.name, S.name)) {
      // Maker sells directly → bilateral; one upstream party (sender = Хто).
      push('sender', M, 'manufacturer');
      contract_type = 'bilateral';
      contract_type_reason = 'Виробник збігається з продавцем в інвойсі → прямий продаж (двосторонній).';
    } else {
      // Maker ≠ seller → a middleman sits between them → trilateral.
      push('sender', M, 'manufacturer');
      push('intermediary', S, 'seller');
      contract_type = 'trilateral';
      contract_type_reason =
        `Виробник («${M.name}») відрізняється від продавця в інвойсі («${S.name}») → ` +
        'продаж через посередника (тристоронній).';
    }
  } else if (M && !S) {
    push('sender', M, 'manufacturer');
    contract_type = null;
    contract_type_reason =
      'Немає продавця в інвойсі — неможливо визначити, чи є посередник (2- або 3-сторонній).';
  } else if (!M && S) {
    // We know who invoices us, but not the maker → can't say if S is the
    // producer or a middleman. Show S, flag the role as unconfirmed, don't guess
    // the contract type.
    push('sender', S, 'seller', true);
    contract_type = null;
    contract_type_reason =
      `Виробника не підтверджено в документах — невідомо, чи продавець («${S.name}») є виробником ` +
      'чи посередником. Тип контракту не визначено.';
  } else {
    contract_type = null;
    contract_type_reason = 'Недостатньо даних про сторони в документах.';
  }

  suggestions.sort((a, b) => b.confidence - a.confidence);
  return { suggestions, contract_type, contract_type_reason };
}
