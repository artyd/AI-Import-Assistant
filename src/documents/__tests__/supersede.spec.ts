import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ query: vi.fn() }));
vi.mock('../../lib/events/fileStatus.js', () => ({ publishFileStatus: vi.fn() }));
vi.mock('../../lib/storage.js', () => ({ deleteStoredFile: vi.fn() }));

const { isSameDocument, normalizeCompany, normalizeNumber } = await import('../supersede.js');

describe('corrected re-upload = same document', () => {
  const inv = { doc_type: 'invoice', invoice_number: 'INV-2024/015', seller: 'Hebei Foo Co., Ltd.' };

  it('normalises numbers and company names', () => {
    expect(normalizeNumber('INV-2024/015')).toBe(normalizeNumber('inv 2024 015'));
    expect(normalizeNumber('12')).toBeNull();
    expect(normalizeCompany('Hebei Foo Co., Ltd.')).toBe(normalizeCompany('HEBEI FOO'));
    expect(normalizeCompany('ТОВ «Альфа Фарм»')).toBe(normalizeCompany('Альфа Фарм'));
  });

  it('same type + number + seller → a new version', () => {
    expect(isSameDocument(inv, { ...inv, invoice_number: 'inv 2024-015', seller: 'HEBEI FOO CO LTD' })).toBe(true);
    expect(isSameDocument({ ...inv, doc_type: 'packing_list' }, { ...inv, doc_type: 'packing_list' })).toBe(true);
  });

  it('trilateral: same invoice number on the two legs is NOT the same document', () => {
    expect(isSameDocument(inv, { ...inv, seller: 'Prime Force Sp. z o.o.' })).toBe(false);
  });

  it('never matches without a seller, a number, or across types', () => {
    expect(isSameDocument(inv, { ...inv, seller: null })).toBe(false);
    expect(isSameDocument(inv, { ...inv, invoice_number: null })).toBe(false);
    expect(isSameDocument(inv, { ...inv, doc_type: 'packing_list' })).toBe(false);
    expect(isSameDocument({ doc_type: 'quality_certificate', invoice_number: 'X123', seller: 'A Co' }, { doc_type: 'quality_certificate', invoice_number: 'X123', seller: 'A Co' })).toBe(false);
  });

  it('transport documents match on number and kind', () => {
    const bl = { doc_type: 'transport', transport_doc_number: 'MEDU1234567', transport_doc_kind: 'mbl' };
    expect(isSameDocument(bl, { ...bl })).toBe(true);
    expect(isSameDocument(bl, { ...bl, transport_doc_kind: 'hbl' })).toBe(false);
  });
});
