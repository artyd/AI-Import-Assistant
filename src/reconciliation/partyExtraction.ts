import { query } from '../db/pool.js';
import type { PartyRole } from './parties.js';

/**
 * Deterministic party + contract-type derivation from a workspace's stored
 * document extractions. Makes NO new LLM call and NEVER guesses.
 *
 * The three fixed slots:
 *   sender       «Хто»        — who sells/ships the goods TO the first buyer in
 *                                the chain: the supplier under the supply contract
 *                                (a trader or the factory itself)
 *   intermediary «Через кого» — a company that BUYS the goods and RESELLS them to
 *                                us (e.g. Prime Force UK) — trilateral deals only
 *   recipient    «Кому»       — the final buyer / importer (us)
 *
 * Bilateral vs trilateral is decided from the deal's commercial legs:
 *   - some company is the BUYER in one contract/invoice and the SELLER in another
 *     (supplier → X, X → importer)                      → TRILATERAL, X = intermediary
 *   - otherwise one seller sells to the buyer            → BILATERAL, even when the
 *     seller is a trader and the manufacturer is another company (Jinyao Singapore
 *     selling Tianyao's API straight to TEKHINFORM is a 2-party contract)
 *   - not enough data                                    → null, with an explicit reason
 *
 * The old rule ("manufacturer ≠ seller → trilateral") turned every trader into an
 * intermediary: the instruction builder then put the trader's Singapore address
 * as the consignee and the factory as the consignor.
 *
 * Every suggestion carries the source files it was read from, so the user sees
 * exactly where each party came from and can confirm/correct.
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
  /** The goods' manufacturer, when the documents name one (not a deal party by
   *  itself — informational, and the country of origin fallback). */
  manufacturer: { name: string; country: string | null } | null;
  contract_type: 'bilateral' | 'trilateral' | null;
  // Human-readable, honest explanation of the contract_type decision (or why it
  // could not be made). Surfaced in the completeness tab.
  contract_type_reason: string;
  // 0..1 confidence in the contract_type verdict. The decision rests on reading
  // BOTH the manufacturer and the invoice seller, so it is the weakest-link
  // corroboration of the two; 0 whenever contract_type could not be decided.
  contract_type_confidence: number;
}

interface ExtractionRow {
  file_name: string;
  fields: Record<string, unknown>;
}

export interface Bucket {
  name: string;
  country: string | null;
  sources: Set<string>;
}

/** One commercial leg: who sells to whom in one contract/invoice. */
export interface Leg {
  seller: string;
  buyer: string;
  source: string;
}

// Documents whose seller/buyer describe a sale (a leg of the deal).
const LEG_DOC_TYPES = new Set(['contract', 'invoice']);

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
     WHERE de.workspace_id = $1 AND f.is_latest = true
       -- 'other' is where unrelated files land (e.g. registration certificates of
       -- a different product) — their makers/holders are not parties of this deal.
       AND COALESCE(de.extracted_fields->>'doc_type', 'other') <> 'other'
     ORDER BY f.created_at, f.name, f.id`,
    [workspaceId],
  );
  const totalDocs = rows.length || 1;

  const manufacturers = new Map<string, Bucket>();
  const sellers = new Map<string, Bucket>();
  const buyers = new Map<string, Bucket>();
  const legs: Leg[] = [];

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
    const seller = str(f.seller);
    const buyer = str(f.buyer);
    if (seller && buyer && LEG_DOC_TYPES.has(str(f.doc_type) ?? '') && !sameEntity(seller, buyer)) {
      legs.push({ seller, buyer, source: src });
    }
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
    legs,
  );
}

/** A company that buys in one leg and resells in another: supplier → X → buyer. */
export function findResaleChain(
  legs: Leg[],
): { supplier: Bucket; intermediary: Bucket; recipient: Bucket } | null {
  let best: { supplier: Bucket; intermediary: Bucket; recipient: Bucket; weight: number } | null = null;
  for (const up of legs) {
    for (const down of legs) {
      if (up === down || up.source === down.source) continue;
      // up: supplier → X ; down: X → recipient
      if (!sameEntity(up.buyer, down.seller)) continue;
      if (sameEntity(up.seller, down.buyer) || sameEntity(up.seller, up.buyer)) continue;
      const bucket = (name: string, sources: string[]): Bucket => ({ name, country: null, sources: new Set(sources) });
      const supplierSrc = legs.filter((l) => sameEntity(l.seller, up.seller) && sameEntity(l.buyer, up.buyer)).map((l) => l.source);
      const recipientSrc = legs.filter((l) => sameEntity(l.seller, down.seller) && sameEntity(l.buyer, down.buyer)).map((l) => l.source);
      const weight = supplierSrc.length + recipientSrc.length;
      if (!best || weight > best.weight) {
        best = {
          supplier: bucket(up.seller, supplierSrc),
          intermediary: bucket(down.seller, [...supplierSrc, ...recipientSrc]),
          recipient: bucket(down.buyer, recipientSrc),
          weight,
        };
      }
    }
  }
  return best ? { supplier: best.supplier, intermediary: best.intermediary, recipient: best.recipient } : null;
}

/**
 * The pure decision: given the top manufacturer / seller / buyer candidates and
 * the deal's commercial legs, assign the three slots and decide the contract type
 * from FACTS. Exported so the 2-/3-sided logic can be unit-tested without a DB.
 */
export function decideParties(
  M: Bucket | null,
  S: Bucket | null,
  B: Bucket | null,
  totalDocs: number,
  legs: Leg[] = [],
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
  const manufacturer = M ? { name: M.name, country: M.country } : null;
  const makerNote = (seller: string): string =>
    M && !sameEntity(M.name, seller) ? ` Виробник — «${M.name}» (лише виробник товару, не сторона угоди).` : '';

  let contract_type: 'bilateral' | 'trilateral' | null = null;
  let contract_type_reason: string;
  let contract_type_confidence = 0;

  const chain = findResaleChain(legs);
  if (chain) {
    // supplier → intermediary → recipient: two sales of the same goods.
    push('sender', chain.supplier, 'seller');
    push('intermediary', chain.intermediary, 'buyer');
    push('recipient', chain.recipient, 'buyer');
    contract_type = 'trilateral';
    contract_type_confidence = Math.min(conf(chain.supplier), conf(chain.recipient));
    contract_type_reason =
      `«${chain.intermediary.name}» купує товар у «${chain.supplier.name}» і перепродає його ` +
      `«${chain.recipient.name}» (два комерційні плечі) → тристоронній.${makerNote(chain.supplier.name)}`;
  } else if (S) {
    // One seller → buyer. A trading company selling someone else's goods is still
    // the contract party — the manufacturer is not.
    push('sender', S, 'seller');
    if (B) push('recipient', B, 'buyer');
    contract_type = 'bilateral';
    const makerKnown = !!M;
    // Weaker when the maker differs (the resale document may just not be
    // uploaded yet) — the user can still override it in the sidebar.
    contract_type_confidence = Math.min(conf(S), B ? conf(B) : conf(S)) * (makerKnown && !sameEntity(M!.name, S.name) ? 0.7 : 1);
    contract_type_reason =
      `Продавець «${S.name}» продає ${B ? `«${B.name}» ` : ''}напряму; документа, де покупець перепродає ` +
      `товар далі, немає → двосторонній.${makerNote(S.name)}`;
  } else if (M) {
    push('sender', M, 'manufacturer', true);
    if (B) push('recipient', B, 'buyer');
    contract_type_reason =
      'Продавця в контракті/інвойсі не знайдено — неможливо визначити, чи є посередник (2- або 3-сторонній).';
  } else {
    if (B) push('recipient', B, 'buyer');
    contract_type_reason = 'Недостатньо даних про сторони в документах.';
  }

  suggestions.sort((a, b) => b.confidence - a.confidence);
  return { suggestions, manufacturer, contract_type, contract_type_reason, contract_type_confidence };
}
