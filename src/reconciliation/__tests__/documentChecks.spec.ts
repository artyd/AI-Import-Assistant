import { describe, expect, it } from 'vitest';
import { checkBankAccounts, documentRisks, isPaymentDoc, normUn, type FlagDoc } from '../documentChecks.js';

// Fictional companies, banks and IBANs only (the repo is public).
const SELLER = 'Fictiva Chemicals GmbH';
const BUYER = 'TOV Zoriana Trade';
const BROKER = 'Nordvale Trading Ltd';
const IBAN_0620 = 'DE12500105170000062011';
const IBAN_0820 = 'DE12500105170000082011';
const IBAN_EUR = 'DE12500105170000099911';
const IBAN_OTHER_BANK = 'DE44370400440532013000';

const doc = (id: string, doc_type: string, fields: Record<string, unknown>, extra: Partial<FlagDoc> = {}): FlagDoc => ({
  file_id: id,
  file_name: `${id}.pdf`,
  doc_type,
  fields,
  ...extra,
});
const acc = (iban: string | null, over: Record<string, unknown> = {}) => ({
  iban, swift: 'TESTDEFF', bank_name: 'Testbank AG', beneficiary: SELLER, ...over,
});
const invoice = (id: string, accounts: unknown[], over: Record<string, unknown> = {}) =>
  doc(id, 'invoice', { seller: SELLER, buyer: BUYER, currency: 'EUR', total_value: 1000, bank_accounts: accounts, ...over });

describe('bank details of one seller', () => {
  it('same bank, different IBAN → confirmed error with two citations', () => {
    const d = checkBankAccounts([invoice('adv', [acc(IBAN_0620)]), invoice('final', [acc(IBAN_0820)])]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ field: 'bank_account', severity: 'error', kind: 'confirmed' });
    expect(d[0]!.citations.map((c) => c.file_name)).toEqual(['adv.pdf', 'final.pdf']);
    expect(d[0]!.actual).toContain(IBAN_0620);
    expect(d[0]!.actual).toContain(IBAN_0820);
    expect(d[0]!.actual).toContain('той самий банк, різні рахунки');
  });

  it('the same account everywhere (spacing aside) → nothing', () => {
    expect(
      checkBankAccounts([invoice('a', [acc(IBAN_0620)]), invoice('b', [acc('DE12 5001 0517 0000 0620 11')])]),
    ).toEqual([]);
  });

  it('an invoice listing both currency accounts and one listing one of them → nothing', () => {
    expect(
      checkBankAccounts([invoice('a', [acc(IBAN_0620), acc(IBAN_EUR)]), invoice('b', [acc(IBAN_EUR)])]),
    ).toEqual([]);
  });

  it('trilateral: same invoice number, different sellers — IBANs are never compared across sellers', () => {
    const inbound = invoice('inbound', [acc(IBAN_0620)], { invoice_number: 'INV-77', buyer: BROKER });
    const outbound = invoice('outbound', [acc(IBAN_0820, { beneficiary: BROKER })], {
      invoice_number: 'INV-77',
      seller: BROKER,
    });
    expect(checkBankAccounts([inbound, outbound])).toEqual([]);
  });

  it('a different beneficiary for the same seller → error', () => {
    const d = checkBankAccounts([
      invoice('a', [acc(IBAN_0620)]),
      invoice('b', [acc(IBAN_0620, { beneficiary: 'Quillmark Holdings SA' })]),
    ]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'error', kind: 'confirmed' });
    expect(d[0]!.actual).toContain('різні отримувачі платежу');
  });

  it('same bank, different IBAN, different invoice currencies → only a suspected warning', () => {
    const d = checkBankAccounts([invoice('a', [acc(IBAN_0620)]), invoice('b', [acc(IBAN_0820)], { currency: 'USD' })]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'warning', kind: 'suspected' });
  });

  it('a different bank with no shared account → suspected warning', () => {
    const d = checkBankAccounts([
      invoice('a', [acc(IBAN_0620)]),
      invoice('b', [acc(IBAN_OTHER_BANK, { swift: 'OTHRDEFF', bank_name: 'Otherbank AG' })]),
    ]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'warning', kind: 'suspected' });
    expect(d[0]!.actual).toContain('різні банки');
  });

  it('old extractions without bank_accounts and invoices without a seller yield nothing', () => {
    expect(checkBankAccounts([doc('a', 'invoice', { seller: SELLER }), doc('b', 'invoice', { seller: SELLER })])).toEqual([]);
    expect(
      checkBankAccounts([invoice('a', [acc(IBAN_0620)], { seller: null }), invoice('b', [acc(IBAN_0820)], { seller: null })]),
    ).toEqual([]);
  });

  it('payment documents: invoices, and «other» files with a total and bank details — not service bills', () => {
    expect(isPaymentDoc(doc('a', 'other', { total_value: 500, bank_accounts: [acc(IBAN_0620)] }))).toBe(true);
    expect(isPaymentDoc(doc('a', 'other', { total_value: 500, bank_accounts: [acc(IBAN_0620)], service_kind: 'freight' }))).toBe(false);
    expect(isPaymentDoc(doc('a', 'other', { bank_accounts: [acc(IBAN_0620)] }))).toBe(false);
    expect(isPaymentDoc(doc('a', 'packing_list', { also_contains: ['invoice'] }))).toBe(true);
    const d = checkBankAccounts([
      invoice('final', [acc(IBAN_0620)]),
      doc('advance', 'other', { seller: SELLER, total_value: 300, bank_accounts: [acc(IBAN_0820)] }),
    ]);
    expect(d).toHaveLength(1);
  });

  it('a bank block made out to the buyer is a payment risk, not a seller mismatch', () => {
    const docs = [
      invoice('final', [acc(IBAN_0620)]),
      invoice('advance', [acc(IBAN_OTHER_BANK, { beneficiary: BUYER, swift: 'OTHRDEFF', bank_name: 'Otherbank AG' })]),
    ];
    expect(checkBankAccounts(docs)).toEqual([]);
    const r = documentRisks(docs).filter((x) => x.code === 'bank_beneficiary_buyer');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ category: 'payment', severity: 'warning', source_file_id: 'advance' });
    expect(r[0]!.detail).toContain(`«${BUYER}»`);
    // the seller's own block never fires
    expect(documentRisks([invoice('final', [acc(IBAN_0620)])])).toEqual([]);
  });
});

describe('dangerous goods', () => {
  const pickup = doc('pickup', 'other', { dangerous_goods: { is_dangerous: true, un_number: 'UN1940', adr_class: '8' } });

  it('declared in one paper, absent from the CMR → info + warning naming the CMR', () => {
    const cmr = doc('cmr', 'transport', {});
    const md = doc('md', 'customs_declaration', { dangerous_goods: { un_number: '1940', adr_class: '8' } });
    const r = documentRisks([pickup, cmr, md]);
    const info = r.find((x) => x.code === 'dangerous_goods');
    expect(info).toMatchObject({ category: 'dangerous_goods', severity: 'info' });
    expect(info!.detail).toContain('UN 1940, клас 8');
    const warn = r.filter((x) => x.code === 'dangerous_goods_undeclared');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ severity: 'warning', source_file_id: 'cmr' });
    // the МД carries UN 1940 itself — only the CMR is named as omitting it
    expect(warn[0]!.detail).toBe('UN 1940, клас 8 заявлено в «pickup.pdf», «md.pdf», але не зазначено в «cmr.pdf».');
    expect(warn[0]!.title).toBe('Небезпечний вантаж UN 1940 не зазначено в транспортних / митних документах');
  });

  it('no transport / customs papers yet → only the info', () => {
    expect(documentRisks([pickup]).map((x) => x.code)).toEqual(['dangerous_goods']);
  });

  it('nothing declared, or declared not dangerous → nothing', () => {
    expect(documentRisks([doc('cmr', 'transport', {}), doc('coa', 'quality_certificate', { dangerous_goods: { is_dangerous: false } })])).toEqual([]);
  });

  it('normUn', () => {
    expect(normUn('UN1940')).toBe('UN 1940');
    expect(normUn('un 1940')).toBe('UN 1940');
    expect(normUn('class 8')).toBeNull();
  });
});

describe('certificates', () => {
  it('unsigned / unstamped / blank fields → a note naming the file and what is missing (CoA: info)', () => {
    const r = documentRisks([doc('coa', 'quality_certificate', { signed: false, stamped: true })]);
    expect(r).toHaveLength(1);
    // A CoA is often issued electronically without a signature — a note, not a problem.
    expect(r[0]).toMatchObject({ code: 'certificate_incomplete', category: 'document_quality', severity: 'info' });
    expect(r[0]!.detail).toBe('«coa.pdf» — без підпису.');
  });

  it('a health certificate (vet flag) with a blank consignee and no stamp', () => {
    const hc = doc('hc', 'other', { stamped: false, signed: null, empty_fields: ['Consignee', 'Date of issue'] }, { vet_certificate: true });
    const r = documentRisks([hc]);
    expect(r).toHaveLength(1);
    expect(r[0]!.title).toBe('Ветеринарний сертифікат оформлено не повністю');
    expect(r[0]!.detail).toBe('«hc.pdf» — без печатки; порожні поля: Consignee, Date of issue.');
  });

  it('unknown signature, SDS, drafts and invoices mentioning a health certificate → nothing', () => {
    expect(documentRisks([doc('coa', 'quality_certificate', { signed: null })])).toEqual([]);
    expect(documentRisks([{ ...doc('x', 'quality_certificate', { signed: false }), file_name: 'MSDS Testol.pdf' }])).toEqual([]);
    expect(documentRisks([{ ...doc('x', 'other', { signed: false }, { vet_certificate: true }), file_name: 'draft HC.pdf' }])).toEqual([]);
    expect(documentRisks([doc('inv', 'invoice', { signed: false }, { vet_certificate: true })])).toEqual([]);
  });
});

describe('commercial documents with blank key fields', () => {
  it('blank invoice number / consignee → warning; batch / date only → info; other blanks ignored', () => {
    const r = documentRisks([
      doc('inv', 'invoice', { empty_fields: ['Invoice No.', 'Batch No.', 'Remarks'] }),
      doc('pl', 'packing_list', { empty_fields: ['Batch No.'] }),
      doc('ct', 'contract', { empty_fields: ['Remarks'] }),
      { ...doc('drft', 'invoice', { empty_fields: ['Invoice No.'] }), file_name: 'invoice.docx' },
    ]);
    expect(r.map((x) => [x.source_file_id, x.code, x.severity])).toEqual([
      ['inv', 'empty_fields', 'warning'],
      ['pl', 'empty_fields', 'info'],
    ]);
    expect(r[0]!.detail).toBe('«inv.pdf» — порожні поля: Invoice No., Batch No.');
  });
});
