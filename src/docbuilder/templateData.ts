import type { AppendixData, ContractData, ContractItem, DocData, DocKind, InvoiceData, Party, UaInvoiceData, Unit } from './schema.js';
import { dateEn, dateUk, moneyEn, moneyUk, priceUk, qtyUk, round } from './format.js';
import { amountWordsEn, amountWordsUk, currencyAfterAmountUk, currencyNameUk, type Currency } from './words.js';

/**
 * Document data → the flat tag map the .docx templates read. Every value is a
 * ready-to-print string; the templates hold no logic beyond loops and
 * «show this line» conditions. The full list of tags per kind is published for
 * authors of custom templates (GET /api/docbuilder/templates/tags).
 */
type Tags = Record<string, unknown>;

const lineTotal = (qty: number, price: number): number => round(qty * price);

export function itemsTotal(items: { qty: number; price: number }[]): number {
  return round(items.reduce((sum, it) => sum + lineTotal(it.qty, it.price), 0));
}

/** Total of any document: contract / annex / invoice in its currency; Ukrainian sale incl. VAT. */
export function documentTotal(kind: DocKind, d: DocData): number {
  if (kind === 'ua_invoice') return uaTotals(d as UaInvoiceData).total;
  return itemsTotal((d as ContractData).items);
}
export const contractTotal = (d: Pick<ContractData, 'items'>) => itemsTotal(d.items);
export const invoiceTotal = (d: Pick<InvoiceData, 'items'>) => itemsTotal(d.items);

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

// ---------- units ----------
const UNIT_LABEL: Record<Unit, { en: string; uk: string; low: string }> = {
  kg: { en: 'KG', uk: 'КГ', low: 'kg' },
  t: { en: 'MT', uk: 'Т', low: 'MT' },
  pcs: { en: 'PCS', uk: 'ШТ', low: 'pcs' },
  l: { en: 'L', uk: 'Л', low: 'l' },
  m2: { en: 'SQ.M', uk: 'М²', low: 'sq.m' },
};

/** One unit for the whole table → it goes into the headers; mixed → into every quantity cell. */
export function unitHeaders(units: Unit[], cur: string): { single: Unit | null; qtyEn: string; qtyUk: string; priceEn: string; priceUk: string; qtyInv: string; priceInv: string } {
  const set = [...new Set(units.length ? units : (['kg'] as Unit[]))];
  const single = set.length === 1 ? set[0]! : null;
  if (single) {
    const u = UNIT_LABEL[single];
    return {
      single,
      qtyEn: `Q-TY, ${u.en}`,
      qtyUk: `КІЛЬКІСТЬ, ${u.uk}`,
      priceEn: `PRICE PER ${u.en}, ${cur}`,
      priceUk: `ЦІНА ЗА ${u.uk}, ${cur}`,
      qtyInv: `Quantity, ${u.low}`,
      priceInv: `Price per ${u.low}, ${cur}`,
    };
  }
  return { single, qtyEn: 'Q-TY', qtyUk: 'КІЛЬКІСТЬ', priceEn: `PRICE PER UNIT, ${cur}`, priceUk: `ЦІНА ЗА ОДИНИЦЮ, ${cur}`, qtyInv: 'Quantity', priceInv: `Price per unit, ${cur}` };
}

const qtyCell = (qty: number, u: Unit, single: Unit | null) => (single ? qtyUk(qty) : `${qtyUk(qty)} ${UNIT_LABEL[u].low}`);

// ---------- payment ----------
type PaymentFields = Pick<ContractData, 'paymentType' | 'paymentDays' | 'prepayDays' | 'prepayPercent'>;

/** Clause 4.1 (contract) / 3 (annex): the agreed way of paying, in both languages. */
export function paymentClause(p: PaymentFields, doc: 'contract' | 'annex'): { en: string; uk: string } {
  const thisEn = doc === 'contract' ? 'this Contract' : 'this Annex';
  const thisUk = doc === 'contract' ? 'цього Контракту' : 'цього Додатку';
  switch (p.paymentType) {
    case 'prepay_full':
      return {
        en: `The Buyer effects 100% prepayment within ${p.prepayDays} days from the date of the Seller's invoice by bank transfer to the Seller's account:`,
        uk: `Покупець здійснює 100% передоплату протягом ${p.prepayDays} днів з дати виставлення рахунку Продавцем банківським переказом на рахунок Продавця:`,
      };
    case 'prepay_part': {
      const rest = 100 - p.prepayPercent;
      return {
        en: `The Buyer effects ${p.prepayPercent}% prepayment within ${p.prepayDays} days from the date of the Seller's invoice, and the remaining ${rest}% within ${p.paymentDays} days following the Goods' delivery, by bank transfer to the Seller's account:`,
        uk: `Покупець здійснює передоплату в розмірі ${p.prepayPercent}% протягом ${p.prepayDays} днів з дати виставлення рахунку Продавцем, а решту ${rest}% — протягом ${p.paymentDays} днів з моменту поставки Товару, банківським переказом на рахунок Продавця:`,
      };
    }
    case 'lc':
      return {
        en: `The payment is effected by an irrevocable documentary letter of credit opened by the Buyer in favour of the Seller within ${p.prepayDays} days from the date of signing of ${thisEn}. The Seller's bank details:`,
        uk: `Оплата здійснюється безвідкличним документарним акредитивом, відкритим Покупцем на користь Продавця протягом ${p.prepayDays} днів з дати підписання ${thisUk}. Банківські реквізити Продавця:`,
      };
    default:
      return {
        en: `The Buyer effects the payment within ${p.paymentDays} days following the Goods' delivery by bank transfer to the Seller's account:`,
        uk: `Покупець здійснює оплату протягом ${p.paymentDays} днів з моменту поставки Товару банківським переказом на рахунок Продавця:`,
      };
  }
}

// ---------- shared pieces ----------
function party(prefix: 's' | 'b', p: Party): Tags {
  return {
    [`${prefix}_name_en`]: p.nameEn,
    [`${prefix}_name_uk`]: p.nameUk || p.nameEn,
    [`${prefix}_country_en`]: p.countryEn,
    [`${prefix}_country_uk`]: p.countryUk,
    [`${prefix}_signatory_en`]: p.signatoryEn,
    [`${prefix}_signatory_uk`]: p.signatoryUk,
    [`${prefix}_basis_en`]: p.basisEn,
    [`${prefix}_basis_uk`]: p.basisUk,
    [`${prefix}_address_en`]: p.addressEn,
    [`${prefix}_address_uk`]: p.addressUk || p.addressEn,
    [`${prefix}_req_en`]: p.requisitesEn,
    [`${prefix}_req_uk`]: p.requisitesUk || p.requisitesEn,
  };
}

function oneLine(...parts: string[]): string {
  return parts.map((p) => p.replace(/\s*\n\s*/g, ', ').trim()).filter(Boolean).join(', ');
}

function consignorClauses(consignor: Party | null, doc: 'contract' | 'annex'): Tags {
  const docEn = doc === 'contract' ? 'Contract' : 'Annex';
  const docUk = doc === 'contract' ? 'Контрактом' : 'Додатком';
  return {
    consignor_clause_en: consignor
      ? `The Consignor of the Goods under the present ${docEn} is ${oneLine(consignor.nameEn, consignor.addressEn)}.`
      : `The Consignor under the present will be informed additionally.`,
    consignor_clause_uk: consignor
      ? `Відправником вантажу за цим ${docUk} є ${oneLine(consignor.nameUk || consignor.nameEn, consignor.addressUk || consignor.addressEn)}.`
      : `Відправником вантажу за цим ${docUk} буде інформовано додатково.`,
  };
}

/** Totals, words, delivery, payment and the specification rows — shared by contract and annex. */
function specTags(d: ContractData | AppendixData, doc: 'contract' | 'annex'): Tags {
  const total = itemsTotal(d.items);
  const h = unitHeaders(d.items.map((i) => i.unit), d.currency);
  const pay = paymentClause(d, doc);
  return {
    cur: d.currency,
    cur_uk: currencyAfterAmountUk(d.currency as Currency),
    cur_name_uk: currencyNameUk(d.currency as Currency),
    amount_en: moneyEn(total),
    amount_uk: moneyUk(total),
    words_en: amountWordsEn(total, d.currency as Currency),
    words_uk: amountWordsUk(total, d.currency as Currency),
    inco_term: d.incoterm,
    inco_place_en: d.incoPlaceEn,
    inco_place_uk: d.incoPlaceUk,
    inco_year: d.incoYear,
    delivery_days: String(d.deliveryDays),
    payment_days: String(d.paymentDays),
    payment_clause_en: pay.en,
    payment_clause_uk: pay.uk,
    show_reg: d.showReg,
    qty_hdr_en: h.qtyEn,
    qty_hdr_uk: h.qtyUk,
    price_hdr_en: h.priceEn,
    price_hdr_uk: h.priceUk,
    origin_en: uniq(d.items.map((i) => i.countryEn)).join(', '),
    origin_uk: uniq(d.items.map((i) => i.countryUk)).join(', '),
    items: d.items.map((it: ContractItem) => ({
      name_en: it.nameEn,
      name_uk: it.nameUk,
      hs: it.hs,
      reg: it.reg,
      manufacturer: it.countryEn ? `${it.manufacturer}, ${it.countryEn}` : it.manufacturer,
      qty: qtyCell(it.qty, it.unit, h.single),
      price: priceUk(it.price),
      total: moneyUk(lineTotal(it.qty, it.price)),
    })),
  };
}

// ---------- per kind ----------
export function contractTags(d: ContractData): Tags {
  const consignee = d.consignee ?? d.buyer;
  return {
    number: d.number,
    date_en: dateEn(d.date),
    date_uk: dateUk(d.date),
    sign_place_en: d.signPlaceEn,
    sign_place_uk: d.signPlaceUk,
    ...party('s', d.seller),
    ...party('b', d.buyer),
    c_name_en: consignee.nameEn,
    c_name_uk: consignee.nameUk || consignee.nameEn,
    c_address_en: consignee.addressEn,
    c_address_uk: consignee.addressUk || consignee.addressEn,
    ...consignorClauses(d.consignor, 'contract'),
    goods_en: d.goodsEn,
    goods_uk: d.goodsUk,
    ...specTags(d, 'contract'),
  };
}

export function appendixTags(d: AppendixData): Tags {
  return {
    appendix_no: d.number,
    number: d.contractNumber,
    contract_number: d.contractNumber,
    contract_date_en: dateEn(d.contractDate),
    contract_date_uk: dateUk(d.contractDate),
    date_en: dateEn(d.date),
    date_uk: dateUk(d.date),
    sign_place_en: d.signPlaceEn,
    sign_place_uk: d.signPlaceUk,
    ...party('s', d.seller),
    ...party('b', d.buyer),
    ...consignorClauses(d.consignor, 'annex'),
    ...specTags(d, 'annex'),
  };
}

/** «APPENDIX No. 21 dated June 30, 2026 TO THE CONTRACT No. 15092023/PMY dated September 15, 2023». */
export function appendixRef(d: Pick<AppendixData, 'number' | 'date' | 'contractNumber' | 'contractDate'>): string {
  const own = dateEn(d.date);
  const contract = dateEn(d.contractDate);
  return `APPENDIX No. ${d.number}${own ? ` dated ${own}` : ''} TO THE CONTRACT No. ${d.contractNumber}${contract ? ` dated ${contract}` : ''}`;
}

export function invoiceTags(d: InvoiceData): Tags {
  const sum = (f: (b: InvoiceData['batches'][number]) => number) => round(d.batches.reduce((a, b) => a + f(b), 0), 3);
  const h = unitHeaders(d.items.map((i) => i.unit), d.currency);
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
    // The letterhead's own seal steps aside once the team places its own stamp on the invoice.
    stamp: d.stamp && !d.stamps.some((x) => x.place === 'invoice' || x.place === 'packing'),
    qty_hdr_en: h.qtyInv,
    price_hdr_en: h.priceInv,
    amount_uk: moneyUk(itemsTotal(d.items)),
    items: d.items.map((it) => ({
      name_en: it.nameEn,
      reg: it.reg,
      manufacturer: it.manufacturer,
      qty: qtyCell(it.qty, it.unit, h.single),
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

export function uaTotals(d: Pick<UaInvoiceData, 'items' | 'vatRate'>): { net: number; vat: number; total: number } {
  const net = itemsTotal(d.items);
  const vat = round((net * d.vatRate) / 100);
  return { net, vat, total: round(net + vat) };
}

export function uaInvoiceTags(d: UaInvoiceData): Tags {
  const t = uaTotals(d);
  const isNakladna = d.docType === 'nakladna';
  return {
    title: isNakladna ? 'ВИДАТКОВА НАКЛАДНА' : 'РАХУНОК НА ОПЛАТУ',
    is_nakladna: isNakladna,
    is_rahunok: !isNakladna,
    number: d.number,
    date_uk: dateUk(d.date),
    place: d.place,
    s_name: d.seller.nameUk || d.seller.nameEn,
    s_req: d.seller.requisitesUk || d.seller.requisitesEn,
    b_name: d.buyer.nameUk || d.buyer.nameEn,
    b_req: d.buyer.requisitesUk || d.buyer.requisitesEn,
    basis: d.basis,
    has_basis: Boolean(d.basis.trim()),
    vat_rate: String(d.vatRate),
    has_vat: d.vatRate > 0,
    no_vat: d.vatRate === 0,
    net_total: moneyUk(t.net),
    vat_total: moneyUk(t.vat),
    total: moneyUk(t.total),
    words: amountWordsUk(t.total, 'UAH'),
    vat_words: t.vat > 0 ? moneyUk(t.vat) : '',
    count: String(d.items.length),
    s_signer: d.sellerSigner,
    b_signer: d.buyerSigner,
    items: d.items.map((it, i) => ({
      n: String(i + 1),
      name: it.name,
      unit: it.unit,
      qty: qtyUk(it.qty),
      price: moneyUk(it.price),
      sum: moneyUk(lineTotal(it.qty, it.price)),
    })),
  };
}

export function tagsFor(kind: DocKind, data: DocData): Tags {
  switch (kind) {
    case 'contract':
      return contractTags(data as ContractData);
    case 'appendix':
      return appendixTags(data as AppendixData);
    case 'invoice':
      return invoiceTags(data as InvoiceData);
    default:
      return uaInvoiceTags(data as UaInvoiceData);
  }
}
