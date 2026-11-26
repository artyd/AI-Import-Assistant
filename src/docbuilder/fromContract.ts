import { invoiceDataSchema, type ContractData, type InvoiceData } from './schema.js';
import { dateEn } from './format.js';

/**
 * «Інвойс до цього контракту»: the invoice + packing list starts from the
 * contract — buyer, terms, goods, quantities and prices carry over; the logist
 * adds the invoice number, batches and weights.
 */
export function invoiceFromContract(c: ContractData, today: string): InvoiceData {
  const consignor = c.consignor ?? c.seller;
  const contractDate = dateEn(c.date);
  return invoiceDataSchema.parse({
    number: '',
    date: today,
    contractRef: contractDate ? `${c.number} dated ${contractDate}` : c.number,
    toName: c.buyer.nameEn,
    toAddress: c.buyer.addressEn,
    consignorName: consignor.nameEn,
    consignorAddress: consignor.addressEn,
    currency: c.currency,
    incoterm: c.incoterm,
    incoPlaceEn: c.incoPlaceEn,
    incoYear: c.incoYear,
    items: c.items.map((it) => ({
      nameEn: it.nameEn,
      reg: it.reg,
      manufacturer: it.countryEn ? `${it.manufacturer}, ${it.countryEn}` : it.manufacturer,
      countryEn: it.countryEn,
      qty: it.qty,
      price: it.price,
    })),
    batches: c.items.map((it) => ({ nameEn: it.nameEn, reg: it.reg, net: it.qty })),
  });
}

/** List-row title: «22052026/PAB · "PC ALLIANCE GROUP" LLC». */
export function documentTitle(kind: 'contract' | 'invoice', data: ContractData | InvoiceData): string {
  const who = kind === 'contract' ? (data as ContractData).buyer.nameEn : (data as InvoiceData).toName;
  return [data.number || 'без номера', who].filter(Boolean).join(' · ');
}
