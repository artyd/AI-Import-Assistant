import { appendixDataSchema, invoiceDataSchema, type AppendixData, type ContractData, type DocData, type DocKind, type InvoiceData, type UaInvoiceData } from './schema.js';
import { dateEn } from './format.js';
import { appendixRef } from './templateData.js';

/**
 * Documents that start from another one:
 * - «Інвойс до контракту / додатку»: buyer, terms, goods, quantities and prices
 *   carry over; the logist adds the invoice number, batches and weights.
 * - «Додаток до контракту»: the next annex — parties and terms from the
 *   contract, an empty specification (goods differ from delivery to delivery).
 */
type Source = Pick<ContractData, 'seller' | 'buyer' | 'consignor' | 'currency' | 'incoterm' | 'incoPlaceEn' | 'incoYear' | 'items'>;

function invoiceFrom(src: Source, contractRef: string, today: string): InvoiceData {
  const consignor = src.consignor ?? src.seller;
  return invoiceDataSchema.parse({
    number: '',
    date: today,
    contractRef,
    toName: src.buyer.nameEn,
    toAddress: src.buyer.addressEn,
    consignorName: consignor.nameEn,
    consignorAddress: consignor.addressEn,
    currency: src.currency,
    incoterm: src.incoterm,
    incoPlaceEn: src.incoPlaceEn,
    incoYear: src.incoYear,
    items: src.items.map((it) => ({
      nameEn: it.nameEn,
      reg: it.reg,
      manufacturer: it.countryEn ? `${it.manufacturer}, ${it.countryEn}` : it.manufacturer,
      countryEn: it.countryEn,
      unit: it.unit,
      qty: it.qty,
      price: it.price,
    })),
    batches: src.items.map((it) => ({ nameEn: it.nameEn, reg: it.reg, net: it.unit === 'kg' ? it.qty : it.unit === 't' ? it.qty * 1000 : 0 })),
  });
}

export function invoiceFromContract(c: ContractData, today: string): InvoiceData {
  const contractDate = dateEn(c.date);
  return invoiceFrom(c, contractDate ? `${c.number} dated ${contractDate}` : c.number, today);
}

export function invoiceFromAppendix(a: AppendixData, today: string): InvoiceData {
  return invoiceFrom(a, appendixRef(a), today);
}

export function appendixFromContract(c: ContractData, number: string, today: string): AppendixData {
  return appendixDataSchema.parse({
    number,
    date: today,
    contractNumber: c.number,
    contractDate: c.date,
    signPlaceEn: c.signPlaceEn,
    signPlaceUk: c.signPlaceUk,
    seller: c.seller,
    buyer: c.buyer,
    consignor: c.consignor,
    currency: c.currency,
    incoterm: c.incoterm,
    incoPlaceEn: c.incoPlaceEn,
    incoPlaceUk: c.incoPlaceUk,
    incoYear: c.incoYear,
    deliveryDays: c.deliveryDays,
    paymentType: c.paymentType,
    paymentDays: c.paymentDays,
    prepayDays: c.prepayDays,
    prepayPercent: c.prepayPercent,
    showReg: c.showReg,
    items: [],
  });
}

/** List-row title: «22052026/PAB · "PC ALLIANCE GROUP" LLC». */
export function documentTitle(kind: DocKind, data: DocData): string {
  switch (kind) {
    case 'contract':
      return [data.number || 'без номера', (data as ContractData).buyer.nameEn].filter(Boolean).join(' · ');
    case 'appendix': {
      const a = data as AppendixData;
      return [`№${a.number || '?'} до ${a.contractNumber || '?'}`, a.buyer.nameEn].filter(Boolean).join(' · ');
    }
    case 'invoice':
      return [data.number || 'без номера', (data as InvoiceData).toName].filter(Boolean).join(' · ');
    default: {
      const u = data as UaInvoiceData;
      return [data.number || 'без номера', u.buyer.nameUk || u.buyer.nameEn].filter(Boolean).join(' · ');
    }
  }
}
