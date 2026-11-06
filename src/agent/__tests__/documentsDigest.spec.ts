import { beforeEach, describe, expect, it, vi } from 'vitest';

let docs: { name: string; fields: Record<string, unknown> }[] = [];
vi.mock('../../db/pool.js', () => ({
  query: vi.fn(async (sql: string) => (sql.includes('document_extractions') ? { rows: docs } : { rows: [] })),
}));

const { buildDocumentsDigest, documentFlags } = await import('../documentsDigest.js');

// Fictional values only (the repo is public).
beforeEach(() => {
  docs = [];
});

describe('document cards in the digest', () => {
  it('flags in words: blank fields, no signature / stamp, dangerous goods, buyer bank block', () => {
    expect(
      documentFlags({
        seller: 'Fictiva Chemicals GmbH',
        buyer: 'TOV Zoriana Trade',
        empty_fields: ['Consignee', 'Batch No.'],
        signed: false,
        stamped: false,
        dangerous_goods: { is_dangerous: true, un_number: 'UN1940', adr_class: '8' },
        bank_accounts: [{ iban: 'UA00 0000 0000 0000 0000 0000 0000 0', beneficiary: 'TOV Zoriana Trade' }],
      }),
    ).toEqual([
      'порожні поля Consignee, Batch No.',
      'без підпису',
      'без печатки',
      'небезпечний вантаж UN 1940 клас 8',
      'реквізити на ім’я покупця «TOV Zoriana Trade»',
    ]);
  });

  it('old extractions and clean documents carry no flags', () => {
    expect(documentFlags({ doc_type: 'invoice', seller: 'X' })).toEqual([]);
    expect(documentFlags({ signed: true, stamped: true, empty_fields: [], dangerous_goods: { is_dangerous: false } })).toEqual([]);
  });

  it('renders the card line with IBAN and the «увага» flags, no emoji', async () => {
    docs = [
      {
        name: 'invoice-1.pdf',
        fields: {
          doc_type: 'invoice',
          seller: 'Fictiva Chemicals GmbH',
          invoice_number: 'FC-104',
          bank_accounts: [{ iban: 'DE12 5001 0517 0000 0620 11' }],
          empty_fields: ['Batch No.'],
          line_items_count: 2,
        },
      },
      { name: 'coa.pdf', fields: { doc_type: 'quality_certificate' } },
    ];
    const digest = await buildDocumentsDigest('ws1');
    expect(digest).toBe(
      '- invoice-1.pdf (invoice): продавець=Fictiva Chemicals GmbH, інвойс№=FC-104, IBAN=DE12500105170000062011, ' +
        '2 позицій; увага: порожні поля Batch No.\n' +
        '- coa.pdf (quality_certificate): (без ключових полів)',
    );
  });

  it('over budget, documents without flags shrink to their name so the flags survive', async () => {
    const long = 'Fictiva Chemicals GmbH '.repeat(4);
    docs = Array.from({ length: 60 }, (_, i) => ({ name: `doc-${i}.pdf`, fields: { doc_type: 'other', seller: long, buyer: long } }));
    docs.push({ name: 'hc.pdf', fields: { doc_type: 'other', signed: false } });
    const digest = await buildDocumentsDigest('ws1');
    expect(digest.length).toBeLessThanOrEqual(4100);
    expect(digest).toContain('- doc-0.pdf (other)\n');
    expect(digest).toContain('- hc.pdf (other): (без ключових полів); увага: без підпису');
  });
});
