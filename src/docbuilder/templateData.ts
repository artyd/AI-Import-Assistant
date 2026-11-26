import type { ContractData, InvoiceData, Party } from './schema.js';
import { dateEn, dateUk, moneyEn, moneyUk, priceUk, qtyUk, round } from './format.js';
import { amountWordsEn, amountWordsUk, currencyAfterAmountUk, currencyNameUk } from './words.js';

/**
 * Document data → the flat tag map the .docx templates read. Every value is a
 * ready-to-print string; the templates hold no logic beyond loops and
 * «show this line» conditions.
 */
type Tags = Record<string, unknown>;

const lineTotal = (qty: number, price: number): number => round(qty * price);

export function contractTotal(d: Pick<ContractData, 'items'>): number {
  return round(d.items.reduce((sum, it) => sum + lineTotal(it.qty, it.price), 0));
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function party(prefix: 's' | 'b', p: Party): Tags {
  return {
    [`${prefix}_name_en`]: p.nameEn,
    [`${prefix}_name_uk`]: p.nameUk,
    [`${prefix}_country_en`]: p.countryEn,
    [`${prefix}_country_uk`]: p.countryUk,
    [`${prefix}_signatory_en`]: p.signatoryEn,
    [`${prefix}_signatory_uk`]: p.signatoryUk,
    [`${prefix}_basis_en`]: p.basisEn,
    [`${prefix}_basis_uk`]: p.basisUk,
    [`${prefix}_req_en`]: p.requisitesEn,
    [`${prefix}_req_uk`]: p.requisitesUk,
  };
}

function oneLine(...parts: string[]): string {
  return parts.map((p) => p.replace(/\s*\n\s*/g, ', ').trim()).filter(Boolean).join(', ');
}

export function contractTags(d: ContractData): Tags {
  const total = contractTotal(d);
  const consignee = d.consignee ?? d.buyer;
  const consignor = d.consignor;
  return {
    number: d.number,
    date_en: dateEn(d.date),
    date_uk: dateUk(d.date),
    sign_place_en: d.signPlaceEn,
    sign_place_uk: d.signPlaceUk,
    ...party('s', d.seller),
    ...party('b', d.buyer),
    c_name_en: consignee.nameEn,
    c_name_uk: consignee.nameUk,
    c_address_en: consignee.addressEn,
    c_address_uk: consignee.addressUk,
    consignor_clause_en: consignor
      ? `The Consignor of the Goods under the present Contract is ${oneLine(consignor.nameEn, consignor.addressEn)}.`
      : 'The Consignor under the present will be informed additionally.',
    consignor_clause_uk: consignor
      ? `Відправником вантажу за цим Контрактом є ${oneLine(consignor.nameUk || consignor.nameEn, consignor.addressUk || consignor.addressEn)}.`
      : 'Відправником вантажу за цим Контрактом буде інформовано додатково.',
    goods_en: d.goodsEn,
    goods_uk: d.goodsUk,
    cur: d.currency,
    cur_uk: currencyAfterAmountUk(d.currency),
    cur_name_uk: currencyNameUk(d.currency),
    amount_en: moneyEn(total),
    amount_uk: moneyUk(total),
    words_en: amountWordsEn(total, d.currency),
    words_uk: amountWordsUk(total, d.currency),
    inco_term: d.incoterm,
    inco_place_en: d.incoPlaceEn,
    inco_place_uk: d.incoPlaceUk,
    inco_year: d.incoYear,
    delivery_days: String(d.deliveryDays),
    payment_days: String(d.paymentDays),
    show_reg: d.showReg,
    origin_en: uniq(d.items.map((i) => i.countryEn)).join(', '),
    origin_uk: uniq(d.items.map((i) => i.countryUk)).join(', '),
    items: d.items.map((it) => ({
      name_en: it.nameEn,
      name_uk: it.nameUk,
      hs: it.hs,
      reg: it.reg,
      manufacturer: it.countryEn ? `${it.manufacturer}, ${it.countryEn}` : it.manufacturer,
      qty: qtyUk(it.qty),
      price: priceUk(it.price),
      total: moneyUk(lineTotal(it.qty, it.price)),
    })),
  };
}

export function invoiceTotal(d: Pick<InvoiceData, 'items'>): number {
  return round(d.items.reduce((sum, it) => sum + lineTotal(it.qty, it.price), 0));
}

export function invoiceTags(d: InvoiceData): Tags {
  const sum = (f: (b: InvoiceData['batches'][number]) => number) => round(d.batches.reduce((a, b) => a + f(b), 0), 3);
  return {
    inv_number: d.number,
    inv_date: dateEn(d.date),
    contract_ref: d.contractRef,
    to_name: d.toName,
    to_address: d.toAddress,
    consignor_name: d.consignorName,
    consignor_address: d.consignorAddress,
    cur: d.currency,
    inco_term: d.incoterm,
    inco_place_en: d.incoPlaceEn,
    inco_year: d.incoYear,
    origin_en: d.originEn || uniq(d.items.map((i) => i.countryEn)).join(', '),
    pallets: d.pallets,
    stamp: d.stamp,
    amount_uk: moneyUk(invoiceTotal(d)),
    items: d.items.map((it) => ({
      name_en: it.nameEn,
      reg: it.reg,
      manufacturer: it.manufacturer,
      qty: qtyUk(it.qty),
      price: priceUk(it.price),
      total: moneyUk(lineTotal(it.qty, it.price)),
    })),
    batches: d.batches.map((b) => ({
      name_en: b.nameEn,
      reg: b.reg,
      batch: b.batch,
      net: qtyUk(b.net),
      gross: qtyUk(b.gross),
      packages: b.packages,
    })),
    net_total: qtyUk(sum((b) => b.net)),
    gross_total: qtyUk(sum((b) => b.gross)),
    packages_total: qtyUk(sum((b) => b.packagesCount)),
  };
}
