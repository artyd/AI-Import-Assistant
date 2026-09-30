import { describe, expect, it } from 'vitest';
import type { ExtractedFields } from '../extractFields.js';
import { mergeExtractions } from '../mergeExtractions.js';

function fields(over: Partial<ExtractedFields>): ExtractedFields {
  return {
    doc_type: 'other',
    also_contains: [],
    po_number: null,
    invoice_number: null,
    contract_number: null,
    total_value: null,
    currency: null,
    hs_code: null,
    country_of_origin: null,
    buyer: null,
    seller: null,
    incoterm: null,
    manufacturer: null,
    registration_number: null,
    document_date: null,
    expiry_date: null,
    shipment_date: null,
    delivery_deadline: null,
    parties: [],
    total_weight_kg: null,
    net_weight_kg: null,
    gross_weight_kg: null,
    packages_count: null,
    line_items: [],
    field_confidence: {},
    extraction_note: null,
    ...over,
  };
}

const item = (description: string) => ({
  description,
  quantity: 1,
  unit: 'kg',
  unit_price: null,
  amount: null,
  hs_code: null,
  batch_no: null,
});

describe('mergeExtractions', () => {
  it('takes header fields from the first part, totals from the last, concatenates line items', () => {
    const merged = mergeExtractions([
      fields({
        doc_type: 'packing_list',
        invoice_number: 'INV-1',
        total_value: 10,
        line_items: [item('A')],
        parties: [{ name: 'ABC Ltd', role: 'seller', country: null, address: null }],
        field_confidence: { invoice_number: 'high', net_weight_kg: 'high' },
      }),
      fields({
        doc_type: 'other',
        invoice_number: 'INV-WRONG',
        net_weight_kg: 500,
        total_value: 999,
        line_items: [item('B')],
        parties: [{ name: 'abc ltd', role: null, country: null, address: null }],
        field_confidence: { net_weight_kg: 'low' },
        extraction_note: 'blurry',
      }),
    ])!;
    expect(merged.doc_type).toBe('packing_list');
    expect(merged.invoice_number).toBe('INV-1');
    expect(merged.total_value).toBe(999);
    expect(merged.net_weight_kg).toBe(500);
    expect(merged.line_items.map((l) => l.description)).toEqual(['A', 'B']);
    expect(merged.parties).toHaveLength(1);
    expect(merged.field_confidence).toEqual({ invoice_number: 'high', net_weight_kg: 'low' });
    expect(merged.extraction_note).toBe('blurry');
  });

  it('returns null for no parts and the part itself for one', () => {
    expect(mergeExtractions([])).toBeNull();
    const one = fields({ invoice_number: 'X' });
    expect(mergeExtractions([one])).toBe(one);
  });
});
