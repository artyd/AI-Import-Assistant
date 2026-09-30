import type { ConfidenceField, ExtractedFields, ExtractedParty, FieldConfidence } from './extractFields.js';

/**
 * Merges the per-part extractions of a long document (multi-pass extraction) into
 * one record. Pure — unit-tested.
 *
 * - Header fields (numbers, parties, dates, codes): FIRST non-null part wins —
 *   they sit at the top of the document.
 * - Totals (total_value, weights, packages): LAST non-null part wins — the
 *   summary row is on the final page.
 * - line_items concatenate in document order; parties de-dupe by name.
 */

const TOTAL_FIELDS = ['total_value', 'total_weight_kg', 'net_weight_kg', 'gross_weight_kg', 'packages_count'] as const;

const HEADER_FIELDS = [
  'po_number',
  'invoice_number',
  'contract_number',
  'currency',
  'hs_code',
  'country_of_origin',
  'buyer',
  'seller',
  'incoterm',
  'manufacturer',
  'registration_number',
  'document_date',
  'expiry_date',
  'shipment_date',
  'delivery_deadline',
] as const;

export function mergeExtractions(parts: ExtractedFields[]): ExtractedFields | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  const merged: ExtractedFields = { ...parts[0]! };

  for (const k of HEADER_FIELDS) {
    const hit = parts.find((p) => p[k] !== null && p[k] !== undefined && p[k] !== '');
    (merged as unknown as Record<string, unknown>)[k] = hit ? hit[k] : null;
  }
  for (const k of TOTAL_FIELDS) {
    const hit = [...parts].reverse().find((p) => p[k] !== null && p[k] !== undefined);
    merged[k] = hit ? hit[k] : null;
  }

  merged.doc_type = parts.find((p) => p.doc_type !== 'other')?.doc_type ?? 'other';
  merged.also_contains = [...new Set(parts.flatMap((p) => [...p.also_contains, p.doc_type]))].filter(
    (t) => t !== merged.doc_type && t !== 'other',
  );
  merged.line_items = parts.flatMap((p) => p.line_items);

  const seen = new Set<string>();
  const parties: ExtractedParty[] = [];
  for (const party of parts.flatMap((p) => p.parties)) {
    const key = party.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parties.push(party);
  }
  merged.parties = parties;

  // Confidence follows the part the value came from; keep the LOWEST seen for
  // a field so a shaky read anywhere still surfaces on the verification screen.
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const conf: FieldConfidence = {};
  for (const p of parts) {
    for (const [f, c] of Object.entries(p.field_confidence) as [ConfidenceField, 'low' | 'medium' | 'high'][]) {
      const prev = conf[f];
      if (!prev || rank[c] < rank[prev]) conf[f] = c;
    }
  }
  merged.field_confidence = conf;

  const notes = [...new Set(parts.map((p) => p.extraction_note).filter((n): n is string => !!n))];
  merged.extraction_note = notes.length ? notes.join(' ') : null;
  return merged;
}
