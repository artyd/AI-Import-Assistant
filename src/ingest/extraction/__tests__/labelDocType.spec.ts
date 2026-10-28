import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/anthropic/client.js', () => ({ anthropic: {}, MODEL: 'test' }));
vi.mock('../../../lib/anthropic/limiter.js', () => ({ runWithAnthropicLimit: (f: () => unknown) => f() }));
vi.mock('../../../lib/config.js', () => ({ config: {} }));

import { correctLabelDocType, type ExtractedFields } from '../extractFields.js';

const base = {
  doc_type: 'packing_list',
  also_contains: [],
  net_weight_kg: 25,
  gross_weight_kg: 28.95,
  packages_count: 1,
  product_name: 'Levomenthol',
  extraction_note: null,
} as unknown as ExtractedFields;

describe('correctLabelDocType', () => {
  it('a drum label read as a packing list becomes "other" without its one-drum weights', () => {
    const f = correctLabelDocType(base, 'Draft Label.pdf');
    expect(f.doc_type).toBe('other');
    expect(f.net_weight_kg).toBeNull();
    expect(f.gross_weight_kg).toBeNull();
    expect(f.product_name).toBe('Levomenthol');
  });

  it('leaves a real packing list alone', () => {
    expect(correctLabelDocType(base, 'Packing List - 291.pdf').doc_type).toBe('packing_list');
    expect(correctLabelDocType(base, 'PL with labels.pdf').doc_type).toBe('packing_list');
  });
});
