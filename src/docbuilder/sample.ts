import { parseData, type DocData, type DocKind } from './schema.js';

/**
 * Fictional data that exercises every tag of a template — used to prove an
 * uploaded template fills, and to list the tags with examples for its author.
 */
const party = {
  nameEn: '"SAMPLE BUYER" LLC', nameUk: 'ТОВ «ЗРАЗОК»', countryEn: 'Ukraine', countryUk: 'Україна',
  signatoryEn: 'Director Ivanenko Olena', signatoryUk: 'Директора Іваненко Олени', basisEn: 'Statute', basisUk: 'Статуту',
  addressEn: 'Ukraine, 61001, Kharkiv, 1, Sample street', addressUk: '61001, Україна, м. Харків, вул. Зразкова 1',
  requisitesEn: 'Enterprise Code 00000000\nIBAN UA000000000000000000000000000', requisitesUk: 'Код ЄДРПОУ 00000000\nIBAN UA000000000000000000000000000', code: 'PSB',
};
const seller = { ...party, nameEn: 'SAMPLE TRADING LIMITED', nameUk: 'SAMPLE TRADING LIMITED', countryEn: 'United Kingdom', countryUk: "Об'єднане Королівство", signatoryEn: 'director John Smith', signatoryUk: 'директора Джона Сміта', basisEn: 'Memorandum of Association', basisUk: 'Установчого договору' };
const item = { nameEn: 'Boric acid', nameUk: 'Борна кислота', hs: '2810009000', reg: 'UA/00000/01/01', manufacturer: 'SAMPLE PHARMA', countryEn: 'India', countryUk: 'Індія', unit: 'kg', qty: 1000, price: 4.36 };

export function sampleData(kind: DocKind): DocData {
  switch (kind) {
    case 'contract':
      return parseData('contract', { number: '01012026/PSB', date: '2026-01-01', seller, buyer: party, incoPlaceEn: 'Bila Tserkva, Ukraine', incoPlaceUk: 'Біла Церква, Україна', showReg: true, items: [item] });
    case 'appendix':
      return parseData('appendix', { number: '2', date: '2026-02-01', contractNumber: '01012026/PSB', contractDate: '2026-01-01', seller, buyer: party, incoPlaceEn: 'Bila Tserkva, Ukraine', incoPlaceUk: 'Біла Церква, Україна', items: [item] });
    case 'invoice':
      return parseData('invoice', {
        number: 'INV-001', date: '2026-02-10', contractRef: '01012026/PSB dated January 1, 2026', toName: party.nameEn, toAddress: party.addressEn,
        consignorName: seller.nameEn, consignorAddress: seller.addressEn, incoPlaceEn: 'Bila Tserkva, Ukraine', pallets: '2 pallets',
        items: [{ nameEn: item.nameEn, reg: item.reg, manufacturer: 'SAMPLE PHARMA, India', countryEn: 'India', unit: 'kg', qty: 1000, price: 4.36 }],
        batches: [{ nameEn: item.nameEn, reg: item.reg, batch: 'B-001', net: 1000, gross: 1080, packages: '40 drums', packagesCount: 40 }],
      });
    default:
      return parseData('ua_invoice', {
        number: '15', date: '2026-02-10', seller: { ...party, nameUk: 'ТОВ «ПРОДАВЕЦЬ»' }, buyer: party, basis: 'Договір поставки № 12 від 01.01.2026',
        sellerSigner: 'Петренко П.П.', buyerSigner: 'Іваненко О.О.', items: [{ name: 'Кислота борна', unit: 'кг', qty: 100, price: 120 }],
      });
  }
}
