import { describe, expect, it } from 'vitest';
import mammoth from 'mammoth';
import PizZip from 'pizzip';
import { contractDataSchema, invoiceDataSchema } from '../schema.js';
import { renderDocx } from '../render.js';

// Fictional companies — the real counterparties live only in the directory.
const seller = {
  nameEn: 'ACME TRADING LIMITED', nameUk: 'ACME TRADING LIMITED',
  countryEn: 'United Kingdom', countryUk: "Об'єднане Королівство",
  signatoryEn: 'director John Smith', signatoryUk: 'директора Джона Сміта',
  basisEn: 'Memorandum of Association', basisUk: 'Установчого договору',
  requisitesEn: 'Address: 1 Test Street\nLONDON\nIBAN: GB00TEST0000', requisitesUk: 'Address: 1 Test Street\nLONDON\nIBAN: GB00TEST0000',
};
const buyer = {
  nameEn: '"TEST BUYER" LLC', nameUk: 'ТОВ «ТЕСТ ПОКУПЕЦЬ»',
  countryEn: 'Ukraine', countryUk: 'Україна',
  signatoryEn: 'Director Ivanenko Olena', signatoryUk: 'Директора Іваненко Олени',
  basisEn: 'Statute', basisUk: 'Статуту',
  addressEn: 'Ukraine, 61001, Kharkiv, 1, Test street', addressUk: '61001, Україна, м. Харків, вул. Тестова 1',
  requisitesEn: 'Enterprise Code 00000000', requisitesUk: 'Код ЄДРПОУ: 00000000',
  code: 'PTB',
};

async function text(buf: Buffer): Promise<string> {
  return (await mammoth.extractRawText({ buffer: buf })).value;
}

function rawXml(buf: Buffer, part: string): string {
  return new PizZip(buf).file(part)?.asText() ?? '';
}

describe('contract + specification', () => {
  const data = contractDataSchema.parse({
    number: '04082026/PTB',
    date: '2026-08-04',
    seller,
    buyer,
    incoPlaceEn: 'Bila Tserkva, Ukraine',
    incoPlaceUk: 'Біла Церква, Україна',
    items: [
      { nameEn: 'Polysorbate-20', nameUk: 'Полісорбат-20', hs: '3402420000', manufacturer: 'INDO AMINES LIMITED', countryEn: 'India', countryUk: 'Індія', qty: 2200, price: 2 },
      { nameEn: 'Polysorbate-80', nameUk: 'Полісорбат-80', hs: '3402420000', manufacturer: 'INDO AMINES LIMITED', countryEn: 'India', countryUk: 'Індія', qty: 3960, price: 2 },
    ],
  });

  it('fills every clause and leaves no tags behind', async () => {
    const buf = await renderDocx('contract', data);
    const t = await text(buf);
    expect(t).toContain('CONTRACT No. 04082026/PTB');
    expect(t).toContain('ACME TRADING LIMITED, United Kingdom as represented by director John Smith');
    expect(t).toContain('ТОВ «ТЕСТ ПОКУПЕЦЬ», Україна, в особі Директора Іваненко Олени, чинного на підставі Статуту');
    expect(t).toContain('USD 12,320.00 (twelve thousand three hundred twenty US dollars and zero cents)');
    expect(t).toContain('12 320,00 доларів США (дванадцять тисяч триста двадцять доларів США 00 центів)');
    expect(t).toContain('on terms CPT Bila Tserkva, Ukraine (INCOTERMS, 2020)');
    expect(t).toContain('will be informed additionally');
    expect(t).toContain('within 60 days following');
    expect(t).toContain('within 90 days following');
    expect(t).toContain('Polysorbate-80');
    expect(t).toContain('HS code: 3402420000');
    expect(t).toContain('Country of origin: India');
    expect(t).not.toContain('Ukrainian reg No.');
    expect(t).not.toMatch(/[{}]/);
    expect(rawXml(buf, 'word/header1.xml') + rawXml(buf, 'word/header2.xml')).toContain('August 4, 2026');
  });

  it('names a consignor and adds the registration line when asked', async () => {
    const t = await text(
      await renderDocx('contract', {
        ...data,
        showReg: true,
        consignor: { ...seller, addressEn: '1 Test Street, London', addressUk: '' } as typeof data.seller,
        items: [{ ...data.items[0]!, reg: 'UA/00000/01/01' }],
      }),
    );
    expect(t).toContain('The Consignor of the Goods under the present Contract is ACME TRADING LIMITED, 1 Test Street, London.');
    expect(t).toContain('Ukrainian reg No.');
    expect(t).toContain('українська реєстрація');
    expect(t).toContain('UA/00000/01/01');
  });
});

describe('invoice + packing list', () => {
  const data = invoiceDataSchema.parse({
    number: 'TB-26/015',
    date: '2026-08-17',
    contractRef: '04082026/PTB dated August 4, 2026',
    toName: buyer.nameEn,
    toAddress: buyer.addressEn,
    consignorName: 'INDO AMINES LIMITED',
    consignorAddress: 'Plot 1, Test Area, India',
    incoPlaceEn: 'Bila Tserkva, Ukraine',
    pallets: '9 pallets',
    items: [{ nameEn: 'Boric acid', reg: 'UA/18432/01/01', manufacturer: 'TEST PHARMA, India', countryEn: 'India', qty: 1000, price: 4.36 }],
    batches: [
      { nameEn: 'Boric acid', batch: 'B-1', net: 600, gross: 650, packages: '24 drums', packagesCount: 24 },
      { nameEn: 'Boric acid', batch: 'B-2', net: 400, gross: 430.5, packages: '16 drums', packagesCount: 16 },
    ],
  });

  it('fills both pages, sums the packing list, keeps the stamp by default', async () => {
    const buf = await renderDocx('invoice', data);
    const t = await text(buf);
    expect(t).toContain('TB-26/015');
    expect(t).toContain('August 17, 2026');
    expect(t).toContain('04082026/PTB dated August 4, 2026');
    expect(t).toContain('4 360,00');
    expect(t).toContain('Total amount CPT Bila Tserkva, Ukraine (INCOTERMS, 2020)');
    expect(t).toContain('B-2');
    expect(t).toContain('1 080,5');
    expect(t).toContain('9 pallets');
    expect(t).not.toMatch(/[{}]/);
    expect(rawXml(buf, 'word/document.xml').match(/<w:pict /g)?.length).toBe(2);
  });

  it('drops the stamp for a draft', async () => {
    const buf = await renderDocx('invoice', { ...data, stamp: false });
    expect(rawXml(buf, 'word/document.xml')).not.toContain('<w:pict');
  });
});
