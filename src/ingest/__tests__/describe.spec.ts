import { describe, expect, it } from 'vitest';
import { describeDocument } from '../describe.js';

describe('describeDocument', () => {
  it('an invoice: number, parties, products', () => {
    expect(
      describeDocument({
        doc_type: 'invoice',
        invoice_number: 'INV-12',
        seller: 'Shandong X Chemical Co., Ltd',
        buyer: 'AGroup95',
        line_items: [
          { description: 'Paracetamol USP 25kg/drum', product_name: 'Paracetamol' },
          { description: 'Ascorbic acid 25 kg bags' },
        ],
      }),
    ).toBe('інвойс, № INV-12, від Shandong X Chemical Co., Ltd → AGroup95, 2 товари: Paracetamol, Ascorbic acid');
  });

  it('a CoA: one product and its batch', () => {
    expect(
      describeDocument({ doc_type: 'quality_certificate', manufacturer: 'Hebei Y', product_name: 'Betaine HCl', batch_number: 'B2301' }),
    ).toBe('сертифікат якості / аналізу, від Hebei Y, товар: Betaine HCl, партія товару B2301');
  });

  it('a house bill', () => {
    expect(describeDocument({ doc_type: 'transport', transport_doc_kind: 'hbl', transport_doc_number: 'BW26010230A' })).toBe(
      'транспортний документ (HBL), № BW26010230A',
    );
  });
});
