import { describe, expect, it, vi } from 'vitest';
import mammoth from 'mammoth';

vi.mock('../../db/pool.js', () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock('../../customs/drugRegistry.js', () => ({ getRegistration: vi.fn(async () => null) }));
vi.mock('../../customs/logist/index.js', () => ({ logistEnabled: () => false, uktzedLookup: vi.fn() }));

const { ibanValid, edrpouValid, swiftValid, requisiteCodes, nextNumber, compareInvoice, checkRequisites } = await import('../checks.js');
const { unitHeaders, paymentClause, uaTotals, appendixRef } = await import('../templateData.js');
const { renderDocx } = await import('../render.js');
const { sampleData } = await import('../sample.js');
const { appendixFromContract, invoiceFromAppendix } = await import('../fromContract.js');
const { amountWordsUk } = await import('../words.js');
const { parseData } = await import('../schema.js');

const text = async (buf: Buffer) => (await mammoth.extractRawText({ buffer: buf })).value;

describe('requisites checksums', () => {
  it('IBAN, SWIFT, ЄДРПОУ', () => {
    expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(ibanValid('GB82WEST12345698765433')).toBe(false);
    expect(ibanValid('UA213223130000026007233566001')).toBe(true);
    expect(ibanValid('UA21322313000002600723356600')).toBe(false); // UA must be 29
    expect(swiftValid('IRVT US 3N')).toBe(true);
    expect(swiftValid('BAD1')).toBe(false);
    expect(edrpouValid('00032129')).toBe(true);
    expect(edrpouValid('14360570')).toBe(true);
    expect(edrpouValid('00032128')).toBe(false);
  });
  it('finds the codes in a requisites block, one per line', () => {
    const c = requisiteCodes('Код ЄДРПОУ: 14360570\nSWIFT код: CRDEUA2N\nACC. IBAN UA213223130000026007233566001\nCorr. bank, SWIFT код IRVT US 3N');
    expect(c).toEqual({ iban: ['UA213223130000026007233566001'], swift: ['CRDEUA2N', 'IRVTUS3N'], edrpou: ['14360570'] });
    const f = checkRequisites('Покупець', { requisitesEn: 'IBAN GB82WEST12345698765433', requisitesUk: 'Код ЄДРПОУ 00032128' });
    expect(f.filter((x) => x.level === 'error')).toHaveLength(2);
  });
});

describe('numbers', () => {
  it('next number keeps the series and padding', () => {
    expect(nextNumber('2627X/0044')).toBe('2627X/0045');
    expect(nextNumber('AI/2026-27/081')).toBe('AI/2026-27/082');
    expect(nextNumber('PM-CI-26-27-15')).toBe('PM-CI-26-27-16');
    expect(nextNumber('QA/SOP/48')).toBe('QA/SOP/49');
    expect(nextNumber('без')).toBe('');
  });
});

describe('units, payment, UAH', () => {
  it('one unit → headers; mixed → per cell', () => {
    expect(unitHeaders(['kg', 'kg'], 'USD')).toMatchObject({ single: 'kg', qtyEn: 'Q-TY, KG', priceUk: 'ЦІНА ЗА КГ, USD', qtyInv: 'Quantity, kg' });
    expect(unitHeaders(['pcs'], 'EUR')).toMatchObject({ priceEn: 'PRICE PER PCS, EUR' });
    expect(unitHeaders(['kg', 'pcs'], 'USD')).toMatchObject({ single: null, qtyEn: 'Q-TY', priceInv: 'Price per unit, USD' });
  });
  it('payment wordings', () => {
    const base = { paymentDays: 90, prepayDays: 5, prepayPercent: 30 };
    expect(paymentClause({ ...base, paymentType: 'deferred' }, 'contract').en).toContain('within 90 days following');
    expect(paymentClause({ ...base, paymentType: 'prepay_full' }, 'contract').uk).toContain('100% передоплату протягом 5 днів');
    const part = paymentClause({ ...base, paymentType: 'prepay_part' }, 'contract');
    expect(part.en).toContain('30% prepayment within 5 days');
    expect(part.en).toContain('remaining 70% within 90 days');
    expect(paymentClause({ ...base, paymentType: 'lc' }, 'annex').en).toContain('of this Annex');
  });
  it('hryvnias are feminine', () => {
    expect(amountWordsUk(1, 'UAH')).toBe('одна гривня 00 копійок');
    expect(amountWordsUk(22.01, 'UAH')).toBe('двадцять дві гривні 01 копійка');
    expect(amountWordsUk(14400, 'UAH')).toBe('чотирнадцять тисяч чотириста гривень 00 копійок');
    expect(uaTotals({ items: [{ qty: 100, price: 120 }], vatRate: 20 })).toEqual({ net: 12000, vat: 2400, total: 14400 });
  });
});

describe('annex to a contract', () => {
  it('carries parties and terms, numbers itself, renders, and its invoice points at it', async () => {
    const c = parseData('contract', sampleData('contract'));
    const a = appendixFromContract(c, '3', '2026-03-01');
    expect(a.items).toEqual([]);
    expect(a.buyer.nameEn).toBe('"SAMPLE BUYER" LLC');
    const full = { ...a, items: c.items };
    const t = await text(await renderDocx('appendix', full));
    expect(t).toContain('ANNEX No. 3 dated March 1, 2026 TO THE CONTRACT No. 01012026/PSB dated January 1, 2026');
    expect(t).toContain('ДОДАТОК № 3 від 1 березня 2026 р. ДО КОНТРАКТУ № 01012026/PSB від 1 січня 2026 р.');
    expect(t).toContain('The total amount of this Annex is USD 4,360.00');
    expect(t).toContain('Boric acid');
    expect(t).not.toMatch(/[{}]/);
    expect(appendixRef(a)).toBe('APPENDIX No. 3 dated March 1, 2026 TO THE CONTRACT No. 01012026/PSB dated January 1, 2026');
    expect(invoiceFromAppendix(full, '2026-03-05').contractRef).toBe(appendixRef(a));
  });
});

describe('every bundled template fills with its sample data', () => {
  for (const kind of ['contract', 'appendix', 'invoice', 'ua_invoice'] as const) {
    it(kind, async () => {
      const t = await text(await renderDocx(kind, sampleData(kind)));
      expect(t.length).toBeGreaterThan(200);
      expect(t).not.toMatch(/[{}]/);
    });
  }
  it('видаткова накладна vs рахунок на оплату', async () => {
    const n = await text(await renderDocx('ua_invoice', sampleData('ua_invoice')));
    expect(n).toContain('ВИДАТКОВА НАКЛАДНА № 15 від 10 лютого 2026 р.');
    expect(n).toContain('Всього з ПДВ: 14 400,00');
    expect(n).toContain('чотирнадцять тисяч чотириста гривень 00 копійок, у т.ч. ПДВ: 2 400,00 грн.');
    expect(n).toContain('Від постачальника');
    const r = await text(await renderDocx('ua_invoice', parseData('ua_invoice', { ...sampleData('ua_invoice'), docType: 'rahunok', vatRate: 0 })));
    expect(r).toContain('РАХУНОК НА ОПЛАТУ');
    expect(r).toContain('Без ПДВ');
    expect(r).toContain('Рахунок дійсний до сплати');
    expect(r).not.toContain('Від постачальника');
  });
  it('mixed units print in the quantity cells', async () => {
    const c = parseData('contract', sampleData('contract'));
    const t = await text(await renderDocx('contract', { ...c, items: [c.items[0]!, { ...c.items[0]!, nameEn: 'Capsules', unit: 'pcs', qty: 5000, price: 0.02 }] }));
    expect(t).toContain('PRICE PER UNIT');
    expect(t).toContain('5 000 pcs');
  });
});

describe('invoice vs its contract', () => {
  const parent = {
    number: 'Контракт 01/PSB',
    buyer: parseData('contract', { buyer: { nameEn: '"B" LLC' } }).buyer,
    seller: parseData('contract', {}).seller,
    currency: 'USD',
    incoterm: 'CPT',
    incoPlaceEn: 'Bila Tserkva, Ukraine',
    items: [{ nameEn: 'Boric acid', qty: 1000, price: 4.36 }],
  };
  const inv = parseData('invoice', { toName: '"B" LLC', currency: 'USD', incoterm: 'CPT', incoPlaceEn: 'Bila Tserkva, Ukraine', items: [{ nameEn: 'Boric acid', qty: 600, price: 4.36 }] });
  it('within the contract → ok', () => {
    expect(compareInvoice(inv, parent, []).filter((f) => f.level !== 'ok')).toEqual([]);
  });
  it('over what is left, wrong price, unknown goods', () => {
    const other = parseData('invoice', { items: [{ nameEn: 'Boric acid', qty: 500, price: 4.36 }] });
    const bad = { ...inv, items: [{ ...inv.items[0]!, price: 4.5 }, { ...inv.items[0]!, nameEn: 'Talc' }] };
    const msgs = compareInvoice(bad, parent, [other]).filter((f) => f.level === 'error').map((f) => f.message).join(' | ');
    expect(msgs).toContain('Контракт 01/PSB: ціна «Boric acid» 4.36, а в інвойсі — 4.5');
    expect(msgs).toContain('перевищує залишок');
    expect(msgs).toContain('товару «Talc» немає в специфікації');
  });
});
