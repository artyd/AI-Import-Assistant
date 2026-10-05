import { countryToUk } from '../domain/countries.js';
import { incotermCode } from './reconcile.js';
import type { WorkspaceRow } from './workspaceAccess.js';

/**
 * Pure derivation of shipment intake context from stored extractions (+ the
 * head of each transport document's Markdown). No I/O — `autoContext.ts` loads
 * the rows and writes the result. Every value is normalised to what the shipment
 * card offers (Incoterm code, transport slug, Ukrainian country name), so the
 * sidebar can display it and the user can correct it.
 */

export interface DeriveDoc {
  file_name: string | null;
  doc_type: string | null;
  fields: Record<string, unknown>;
  /** First few KB of the document Markdown (transport docs only). */
  markdown?: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|llc|inc|gmbh|co|corp|company|pvt|private|business)\b/g, '')
    .replace(/[^a-z0-9а-яіїєґ]/gi, '');
}

/** Same legal entity, tolerant of "Ltd/Limited" and spelling of punctuation. */
export function sameCompany(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ka = normName(a);
  const kb = normName(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // Substring tolerance ("Prime Force UK" ⊂ "Prime Force UK Business") only for
  // names long enough not to collide ("ag" would match half the market).
  return Math.min(ka.length, kb.length) >= 5 && (ka.includes(kb) || kb.includes(ka));
}

/**
 * Country of origin of the GOODS — read from the documents that state it, in
 * order of authority (COO › МД › invoice › packing list › COA), majority-voted;
 * else the sender/manufacturer's country. Never the buyer's country.
 */
const ORIGIN_AUTHORITY = [
  'certificate_of_origin',
  'customs_declaration',
  'invoice',
  'packing_list',
  'quality_certificate',
];
export function deriveOriginCountry(docs: DeriveDoc[], senderCountry: string | null): string | null {
  const votes = new Map<string, { n: number; rank: number }>();
  for (const d of docs) {
    const rank = ORIGIN_AUTHORITY.indexOf(d.doc_type ?? '');
    if (rank < 0) continue;
    const c = countryToUk(str(d.fields.country_of_origin));
    if (!c) continue;
    const v = votes.get(c) ?? { n: 0, rank };
    v.n += 1;
    v.rank = Math.min(v.rank, rank);
    votes.set(c, v);
  }
  const best = [...votes.entries()].sort((a, b) => a[1].rank - b[1].rank || b[1].n - a[1].n)[0];
  return best?.[0] ?? countryToUk(senderCountry);
}

/**
 * Incoterms per leg. Trilateral: the inbound leg is the document the
 * intermediary BUYS on (supplier → intermediary), the outbound leg the one it
 * SELLS on (intermediary → importer). Bilateral: one leg (invoice › contract).
 * Invoices outrank contracts; the rule code only ("CPT"), the place is dropped.
 */
export function deriveIncoterms(
  docs: DeriveDoc[],
  mode: 'bilateral' | 'trilateral' | null,
  intermediary: string | null,
): { incoterm_in: string | null; incoterm_out: string | null } {
  const legOf = (d: DeriveDoc): 'in' | 'out' | null => {
    if (mode !== 'trilateral' || !intermediary) return null;
    if (sameCompany(str(d.fields.buyer), intermediary)) return 'in';
    if (sameCompany(str(d.fields.seller), intermediary)) return 'out';
    return null;
  };
  const codeFrom = (types: string[], leg: 'in' | 'out' | null): string | null => {
    for (const t of types) {
      for (const d of docs) {
        if (d.doc_type !== t) continue;
        if (leg && legOf(d) !== leg) continue;
        const c = incotermCode(str(d.fields.incoterm));
        if (c) return c;
      }
    }
    return null;
  };
  if (mode === 'trilateral' && intermediary) {
    return {
      incoterm_in: codeFrom(['invoice', 'contract'], 'in'),
      incoterm_out: codeFrom(['invoice', 'contract'], 'out'),
    };
  }
  return { incoterm_in: codeFrom(['invoice', 'contract'], null), incoterm_out: null };
}

/**
 * Transport mode from the international transport documents: AWB → air,
 * CMR → road, B/L → sea, SMGS/CIM → rail; several distinct modes → multimodal.
 * The domestic last-mile courier note (Нова Пошта) is not the shipment's mode.
 */
const MODE_RULES: [mode: string, rx: RegExp][] = [
  ['air', /\b(air\s*way\s*bill|airway\s*bill|awb|hawb|mawb|airport\s+of\s+departure)\b/i],
  ['road', /\b(cmr|road\s+consignment)\b|міжнародна\s+товарно-транспортна/i],
  ['sea', /\b(bill\s+of\s+lading|b\/l|ocean\s+vessel|port\s+of\s+loading)\b|коносамент/i],
  ['rail', /\b(smgs|cim\s+consignment|railway\s+bill)\b|смгс|залізнична\s+накладна/i],
];
const DOMESTIC_COURIER_RX = /нова\s*пошта|nova\s*poshta|експрес-накладна/i;
export function deriveTransportMode(docs: DeriveDoc[]): string | null {
  const modes = new Set<string>();
  for (const d of docs) {
    if (d.doc_type !== 'transport') continue;
    // The extractor's own reading of THIS document's mode wins; the text
    // heuristics below cover extractions made before the field existed.
    const read = typeof d.fields.transport_mode === 'string' ? d.fields.transport_mode : null;
    if (read === 'courier') continue; // last-mile courier is not the shipment's mode
    if (read && ['air', 'road', 'sea', 'rail'].includes(read)) {
      modes.add(read);
      continue;
    }
    // A CMR or T1 often CITES the AWB number further down; what the document IS
    // shows first (file name, title). So: the rule matching EARLIEST wins.
    const text = `${d.file_name ?? ''}\n${(d.markdown ?? '').slice(0, 1500)}`;
    if (DOMESTIC_COURIER_RX.test(text)) continue;
    let best: { mode: string; at: number } | null = null;
    for (const [mode, rx] of MODE_RULES) {
      const m = rx.exec(text);
      if (m && (best === null || m.index < best.at)) best = { mode, at: m.index };
    }
    if (best) modes.add(best.mode);
  }
  if (modes.size === 0) return null;
  return modes.size === 1 ? [...modes][0]! : 'multimodal';
}

/** Values the shipment card can show: anything else was not chosen in the UI. */
const UI_TRANSPORT = new Set(['sea', 'air', 'rail', 'road', 'multimodal', 'inland_waterway', 'pipeline', 'courier']);
export function isUiValue(field: string, value: string | null): boolean {
  if (value === null) return true;
  if (field === 'incoterm_in' || field === 'incoterm_out') return /^[A-Z]{3}$/.test(value);
  if (field === 'transport_mode') return UI_TRANSPORT.has(value);
  if (field === 'origin_country' || field === 'destination_country') return countryToUk(value) === value;
  return true;
}

/** Intake fields the document autopilot may fill (see autoContext.ts). */
export type AutoField = 'incoterm_in' | 'incoterm_out' | 'transport_mode' | 'origin_country' | 'destination_country';
export const AUTO_FIELDS: readonly AutoField[] = [
  'incoterm_in',
  'incoterm_out',
  'transport_mode',
  'origin_country',
  'destination_country',
];

/**
 * The tracked intake fields a manual write actually CHANGES. The sidebar's Save
 * sends every field, so stamping all sent keys would freeze autopilot values
 * the user never touched.
 */
export function changedFields(
  ws: Pick<WorkspaceRow, AutoField>,
  data: Record<string, unknown>,
): string[] {
  return Object.keys(data).filter((k) => {
    const v = data[k];
    if (v === undefined || !AUTO_FIELDS.includes(k as AutoField)) return false;
    return (v ?? null) !== (ws[k as AutoField] ?? null);
  });
}
