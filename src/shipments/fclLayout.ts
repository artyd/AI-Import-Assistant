import { sameGoods, type AssignFields } from './lotAssign.js';

/**
 * Where a document goes INSIDE its lot (spec 007). Pure — the Postgres side is
 * `lots.ts`, the filing is `documents/classify.ts`.
 *
 *   Митниця / <постачальник>  — invoice, packing list, contract, certificate of
 *                               origin, marking/labels, shipping instruction
 *   <постачальник> / <товар>  — everything about one product (CoA, MSDS,
 *                               specification, registration, photos…)
 *   <постачальник>            — a product paper whose product is unknown
 *
 * A document that names several products is linked into each of their folders.
 */

/** Document types that belong to the lot's customs folder. */
const CUSTOMS_TYPES = new Set(['invoice', 'packing_list', 'contract', 'certificate_of_origin', 'label', 'instruction']);
/** Types that may create a product folder (the anchor documents). */
const ANCHOR_TYPES = new Set(['invoice', 'packing_list', 'contract']);

export type LotPlace = 'lot_customs' | 'product' | 'lot_root';

export function placeInLot(docType: string | null): Exclude<LotPlace, 'lot_root'> {
  return docType && CUSTOMS_TYPES.has(docType) ? 'lot_customs' : 'product';
}

export function createsProducts(docType: string | null): boolean {
  return !!docType && ANCHOR_TYPES.has(docType);
}

export interface ProductRef {
  /** Folder name: the short product name. */
  name: string;
  cas: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const CAS_RX = /\b\d{2,7}-\d{2}-\d\b/;

/**
 * A folder-worthy product name from an invoice line: drops packing, quantities
 * and grade noise ("Paracetamol USP 25kg/drum (Batch 2301)" → "Paracetamol USP").
 */
export function shortProductName(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/\(.*?\)|\[.*?\]/g, ' ');
  // Cut at the first quantity / packing token.
  const cut = s.search(/\b\d+([.,]\d+)?\s*(kg|кг|g|г|l|л|ml|мл|mt|t|т|pcs|шт|bags?|drums?|cartons?|ctns?|мішк|бочк)\b|\b(net|gross|нетто|брутто|batch|lot|cas)\b|[,;:/]/i);
  if (cut > 2) s = s.slice(0, cut);
  s = s.replace(/\b\d{2,7}-\d{2}-\d\b/g, ' ').replace(/\s+/g, ' ').replace(/[\s\-–—.]+$/, '').trim();
  return (s || raw.trim()).slice(0, 60);
}

/** The products a document names: line items (short name + CAS) and the main product. */
export function docProducts(fields: AssignFields | null): ProductRef[] {
  if (!fields) return [];
  const out: ProductRef[] = [];
  const add = (name: string | null, cas: string | null): void => {
    const label = name ? shortProductName(name) : null;
    if (!label && !cas) return;
    const ref: ProductRef = { name: label ?? cas!, cas };
    if (!out.some((p) => sameProduct(p, ref))) out.push(ref);
  };
  if (Array.isArray(fields.line_items)) {
    for (const li of fields.line_items as Record<string, unknown>[]) {
      const desc = str(li?.description);
      add(str(li?.product_name) ?? desc, str(li?.cas_number) ?? desc?.match(CAS_RX)?.[0] ?? null);
    }
  }
  add(str(fields.product_name), str(fields.cas_number));
  return out;
}

/** The text a product folder is matched by (stored as `folders.product_key`). */
export function productKey(p: ProductRef): string {
  return p.cas ? `${p.name} ${p.cas}` : p.name;
}

export function sameProduct(a: ProductRef, b: ProductRef): boolean {
  if (a.cas && b.cas) return a.cas === b.cas;
  return sameGoods(productKey(a), productKey(b));
}

export interface ProductFolder {
  id: string;
  product_key: string;
}

/** The existing product folder of a product, if any. */
export function findProductFolder(folders: ProductFolder[], p: ProductRef): ProductFolder | null {
  const cas = p.cas;
  if (cas) {
    const byCas = folders.find((f) => f.product_key.match(CAS_RX)?.[0] === cas);
    if (byCas) return byCas;
  }
  return folders.find((f) => sameGoods(f.product_key, productKey(p))) ?? null;
}

/**
 * The product folder a file NAME points to ("photo of D-Glucosamine Hcl 2.jpg"),
 * for papers whose content names no product (photos, labels). Only an
 * unambiguous match counts — a name that fits two products returns null.
 */
export function productFolderByFileName<T extends ProductFolder>(folders: T[], fileName: string): T | null {
  const stem = fileName.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ');
  const hits = folders.filter((f) => sameGoods(stem, f.product_key));
  const keys = new Set(hits.map((h) => h.product_key.toLowerCase()));
  return hits.length > 0 && keys.size === 1 ? hits[0]! : null;
}
