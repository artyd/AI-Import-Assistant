import { describe, expect, it } from 'vitest';
import { contractDataSchema } from '../schema.js';
import { documentTitle, invoiceFromContract } from '../fromContract.js';

describe('invoice from a contract', () => {
  const c = contractDataSchema.parse({
    number: '22052026/PTB',
    date: '2026-05-22',
    seller: { nameEn: 'ACME TRADING LIMITED', addressEn: '1 Test Street, London' },
    buyer: { nameEn: '"TEST BUYER" LLC', addressEn: 'Kharkiv, Ukraine' },
    incoPlaceEn: 'Bila Tserkva, Ukraine',
    items: [{ nameEn: 'Boric acid', reg: 'UA/1', manufacturer: 'TEST PHARMA', countryEn: 'India', qty: 1000, price: 4.36 }],
  });

  it('carries buyer, terms, goods and a ready contract reference', () => {
    const inv = invoiceFromContract(c, '2026-08-17');
    expect(inv.contractRef).toBe('22052026/PTB dated May 22, 2026');
    expect(inv.toName).toBe('"TEST BUYER" LLC');
    expect(inv.consignorName).toBe('ACME TRADING LIMITED'); // no consignor → the seller ships
    expect(inv.items[0]).toMatchObject({ nameEn: 'Boric acid', manufacturer: 'TEST PHARMA, India', qty: 1000, price: 4.36 });
    expect(inv.batches[0]).toMatchObject({ nameEn: 'Boric acid', reg: 'UA/1', net: 1000, batch: '' });
    expect(inv.date).toBe('2026-08-17');
  });

  it('titles the list row with number and counterparty', () => {
    expect(documentTitle('contract', c)).toBe('22052026/PTB · "TEST BUYER" LLC');
    expect(documentTitle('invoice', invoiceFromContract(c, '2026-08-17'))).toBe('без номера · "TEST BUYER" LLC');
  });
});
