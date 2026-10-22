import { sameCompany } from './contextDerive.js';
import { INTERNAL_COMPANIES } from '../reconciliation/internalCompanies.js';
import type { TransportDocKind } from '../ingest/extraction/extractFields.js';

/**
 * Lot assignment for an FCL (Збірник, spec 006): which lot a document belongs to,
 * or whether it is an FCL-level paper (transport, customs, manifest). Pure and
 * deterministic — it reads the document's extraction and the lots' own documents,
 * never guesses: anything ambiguous goes to the inbox with a suggestion.
 *
 * Rules, in order:
 *   1. manifest / transport / customs declaration → the FCL folders. House bills
 *      also stay at the FCL level; they are matched to a lot by shipper later.
 *   2. invoice / packing list / contract → the lot of its SELLER. A seller that is
 *      one of our own companies (the resale leg, e.g. Prime Force → consignee) is
 *      no supplier: that document goes by the goods it lists instead.
 *   3. a new seller on one of those anchor documents → a NEW lot.
 *   4. anything else (CoO, CoA, MSDS…) → by exporter/seller, batch number,
 *      manufacturer or goods; never creates a lot.
 */

export interface AssignFields {
  doc_type?: unknown;
  seller?: unknown;
  buyer?: unknown;
  manufacturer?: unknown;
  consignor_name?: unknown;
  product_name?: unknown;
  cas_number?: unknown;
  batch_number?: unknown;
  line_items?: unknown;
  transport_doc_kind?: unknown;
  transport_doc_number?: unknown;
  parties?: unknown;
}

export interface AssignDoc {
  file_name: string;
  /** Stored file type (pdf/xlsx/csv/…): a spreadsheet named «manifest» is the manifest. */
  file_type: string;
  fields: AssignFields | null;
}

/** What the resolver knows about one lot, built from the lot's own documents. */
export interface LotProfile {
  id: string;
  name: string;
  supplier_name: string;
  /** Product names, line-item descriptions and CAS numbers of the lot's documents. */
  goods: string[];
  manufacturers: string[];
  batches: string[];
}

export type FclFolder = 'manifest' | 'transport' | 'customs';

export type Assignment =
  | { kind: 'fcl'; folder: FclFolder; reason: string }
  | { kind: 'lot'; lotId: string; confidence: 'high' | 'medium'; reason: string }
  | { kind: 'new'; supplierName: string; reason: string }
  | { kind: 'inbox'; suggestLotId: string | null; reason: string };

const ANCHOR_TYPES = new Set(['invoice', 'packing_list', 'contract']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** One of our own group companies (the importer or our intermediary). */
export function isInternalCompany(name: string | null): boolean {
  return !!name && INTERNAL_COMPANIES.some((c) => sameCompany(name, c));
}

const KIND_RULES: { kind: TransportDocKind; rx: RegExp }[] = [
  { kind: 'manifest', rx: /manifest|маніфест|манифест/i },
  { kind: 'hbl', rx: /\bhbl\b|house\s*b\/?l|house bill|\bhb\/?l\b/i },
  { kind: 'mbl', rx: /\bmbl\b|master\s*b\/?l|master bill|ocean bill/i },
  { kind: 'transit', rx: /\bt-?1\b|\bncts\b|\bmrn\b|транзит/i },
  { kind: 'cmr', rx: /\bcmr\b/i },
  { kind: 'awb', rx: /\b[hm]?awb\b|air\s*way\s*bill|airwaybill/i },
];

/**
 * The kind of a transport paper: the extracted `transport_doc_kind`, else the
 * file name / document number. null when nothing says which kind it is.
 */
export function transportDocKind(fileName: string, fields: AssignFields | null): TransportDocKind | null {
  const stated = str(fields?.transport_doc_kind) as TransportDocKind | null;
  if (stated && stated !== 'other') return stated;
  const hay = `${fileName} ${str(fields?.transport_doc_number) ?? ''}`.replace(/[_.]/g, ' ');
  return KIND_RULES.find((r) => r.rx.test(hay))?.kind ?? null;
}

/** Spreadsheet or document that is the collection's manifest. */
export function isManifest(doc: AssignDoc): boolean {
  if (transportDocKind(doc.file_name, doc.fields) === 'manifest') return true;
  return (doc.file_type === 'xlsx' || doc.file_type === 'csv') && /manifest|маніфест|манифест/i.test(doc.file_name);
}

// ── goods matching ────────────────────────────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'grade', 'powder', 'usp', 'bp', 'ep', 'kg', 'pcs', 'drum', 'drums', 'bag', 'bags']);

/** Significant tokens of a product name (lowercased, ≥3 chars, no packing words). */
export function goodsTokens(name: string): Set<string> {
  const out = new Set<string>();
  for (const t of name.toLowerCase().split(/[^\p{L}\p{N}-]+/u)) {
    const tok = t.replace(/^-+|-+$/g, '');
    if (tok.length >= 3 && !STOP.has(tok) && !/^\d+$/.test(tok)) out.add(tok);
  }
  return out;
}

const CAS_RX = /\b\d{2,7}-\d{2}-\d\b/;

/** Same product? Same CAS, or most of the shorter name's tokens are in the other. */
export function sameGoods(a: string, b: string): boolean {
  const ca = a.match(CAS_RX)?.[0];
  const cb = b.match(CAS_RX)?.[0];
  if (ca && cb) return ca === cb;
  const ta = goodsTokens(a);
  const tb = goodsTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.min(ta.size, tb.size) >= 0.6;
}

/** The goods a document lists: product name, CAS, line-item descriptions. */
export function docGoods(fields: AssignFields | null): string[] {
  if (!fields) return [];
  const out: string[] = [];
  const product = str(fields.product_name);
  const cas = str(fields.cas_number);
  if (product) out.push(cas ? `${product} ${cas}` : product);
  else if (cas) out.push(cas);
  if (Array.isArray(fields.line_items)) {
    for (const li of fields.line_items as { description?: unknown }[]) {
      const d = str(li?.description);
      if (d) out.push(d);
    }
  }
  return out;
}

/** Lots whose goods share a product with this document. */
function lotsByGoods(goods: string[], lots: LotProfile[]): LotProfile[] {
  if (goods.length === 0) return [];
  return lots.filter((l) => l.goods.some((g) => goods.some((d) => sameGoods(g, d))));
}

/** Non-internal seller-side names a document states (seller, exporter, shipper). */
function supplierNames(fields: AssignFields | null): string[] {
  if (!fields) return [];
  const names = [str(fields.seller), str(fields.consignor_name)];
  if (Array.isArray(fields.parties)) {
    for (const p of fields.parties as { name?: unknown; role?: unknown }[]) {
      if (/seller|exporter|shipper|consignor|supplier|продав|експорт|постачальн|відправник/i.test(str(p?.role) ?? '')) {
        names.push(str(p?.name));
      }
    }
  }
  return [...new Set(names.filter((n): n is string => !!n && !isInternalCompany(n)))];
}

function lotBySupplier(names: string[], lots: LotProfile[]): LotProfile | null {
  for (const n of names) {
    const hit = lots.find((l) => sameCompany(l.supplier_name, n));
    if (hit) return hit;
  }
  return null;
}

function unique<T>(list: T[]): T | null {
  return list.length === 1 ? list[0]! : null;
}

export function assignLot(doc: AssignDoc, lots: LotProfile[]): Assignment {
  const f = doc.fields;
  const docType = str(f?.doc_type) ?? 'other';

  // 1. FCL-level papers.
  if (isManifest(doc)) return { kind: 'fcl', folder: 'manifest', reason: 'маніфест збірника → папка FCL' };
  if (docType === 'transport') {
    const kind = transportDocKind(doc.file_name, f);
    return { kind: 'fcl', folder: 'transport', reason: `транспортний документ${kind ? ` (${kind.toUpperCase()})` : ''} → папка FCL` };
  }
  if (docType === 'customs_declaration') return { kind: 'fcl', folder: 'customs', reason: 'митна декларація → папка FCL' };

  const suppliers = supplierNames(f);
  const goods = docGoods(f);

  // 2–3. Anchor documents: by seller, else by goods (our own resale leg).
  if (ANCHOR_TYPES.has(docType)) {
    const bySeller = lotBySupplier(suppliers, lots);
    if (bySeller) return { kind: 'lot', lotId: bySeller.id, confidence: 'high', reason: `продавець «${bySeller.supplier_name}» → ${bySeller.name}` };
    const seller = str(f?.seller);
    if (suppliers.length > 0 && seller && !isInternalCompany(seller)) {
      return { kind: 'new', supplierName: seller, reason: `новий постачальник «${seller}» → нова партія` };
    }
    const byGoods = lotsByGoods(goods, lots);
    const one = unique(byGoods);
    if (one) return { kind: 'lot', lotId: one.id, confidence: 'medium', reason: `товар збігається з ${one.name}` };
    if (suppliers[0] && !seller) {
      // A packing list that names only the shipper.
      return { kind: 'new', supplierName: suppliers[0], reason: `новий постачальник «${suppliers[0]}» → нова партія` };
    }
    return { kind: 'inbox', suggestLotId: byGoods[0]?.id ?? null, reason: byGoods.length > 1 ? 'товар є в кількох партіях' : 'не вдалося визначити постачальника' };
  }

  // 4. Supporting documents never create a lot.
  const bySeller = lotBySupplier(suppliers, lots);
  if (bySeller) return { kind: 'lot', lotId: bySeller.id, confidence: 'high', reason: `експортер «${bySeller.supplier_name}» → ${bySeller.name}` };

  const batch = str(f?.batch_number);
  if (batch) {
    const byBatch = unique(lots.filter((l) => l.batches.some((b) => b.toLowerCase() === batch.toLowerCase())));
    if (byBatch) return { kind: 'lot', lotId: byBatch.id, confidence: 'high', reason: `номер партії товару ${batch} → ${byBatch.name}` };
  }

  const byGoods = lotsByGoods(goods, lots);
  const manufacturer = str(f?.manufacturer);
  const narrowed = manufacturer && byGoods.length > 1
    ? byGoods.filter((l) => l.manufacturers.some((m) => sameCompany(m, manufacturer)) || sameCompany(l.supplier_name, manufacturer))
    : byGoods;
  const one = unique(narrowed);
  if (one) return { kind: 'lot', lotId: one.id, confidence: 'medium', reason: `товар збігається з ${one.name}` };

  if (manufacturer && byGoods.length === 0) {
    const byMaker = unique(lots.filter((l) => l.manufacturers.some((m) => sameCompany(m, manufacturer)) || sameCompany(l.supplier_name, manufacturer)));
    if (byMaker) return { kind: 'lot', lotId: byMaker.id, confidence: 'medium', reason: `виробник «${manufacturer}» → ${byMaker.name}` };
  }

  return {
    kind: 'inbox',
    suggestLotId: narrowed[0]?.id ?? null,
    reason: narrowed.length > 1 ? 'товар є в кількох партіях' : 'немає ознак партії',
  };
}

/** A short lot name from the supplier's legal name ("Shandong X Chemical Co., Ltd" → "Shandong X Chemical"). */
export function lotNameFor(supplier: string): string {
  const cleaned = supplier
    .replace(/\b(co\.?|ltd\.?|limited|llc|inc\.?|gmbh|corp\.?|company|pvt\.?|private|import\s*&\s*export|imp\.?\s*&\s*exp\.?)\b/gi, ' ')
    .replace(/[.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || supplier).slice(0, 60);
}

/** Lot profiles from the extractions of the files sitting in each lot's folder. */
export function buildLotProfiles(
  lots: { id: string; name: string; supplier_name: string }[],
  files: { lot_id: string | null; fields: AssignFields | null }[],
): LotProfile[] {
  return lots.map((l) => {
    const mine = files.filter((x) => x.lot_id === l.id && x.fields);
    const goods = new Set<string>();
    const manufacturers = new Set<string>();
    const batches = new Set<string>();
    for (const x of mine) {
      for (const g of docGoods(x.fields)) goods.add(g);
      const m = str(x.fields!.manufacturer);
      if (m) manufacturers.add(m);
      const b = str(x.fields!.batch_number);
      if (b) batches.add(b);
      if (Array.isArray(x.fields!.line_items)) {
        for (const li of x.fields!.line_items as { batch_no?: unknown }[]) {
          const bn = str(li?.batch_no);
          if (bn) batches.add(bn);
        }
      }
    }
    return { ...l, goods: [...goods], manufacturers: [...manufacturers], batches: [...batches] };
  });
}
