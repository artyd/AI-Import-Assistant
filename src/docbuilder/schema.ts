import { z } from 'zod';

/**
 * Document builder (spec 012) — the data a logist assembles a trade document
 * from. A document stores SNAPSHOTS of its parties and goods, so editing the
 * directory later never rewrites a document that was already sent.
 */
const s = (max = 500) => z.string().trim().max(max).default('');
const block = s(3000); // multi-line requisites

/**
 * contract   — bilingual contract + specification (Annex No. 1)
 * appendix   — a numbered annex (specification) to an existing contract
 * invoice    — invoice + packing list on the seller's letterhead
 * ua_invoice — Ukrainian видаткова накладна / рахунок на оплату (domestic sales)
 */
export const DOC_KINDS = ['contract', 'appendix', 'invoice', 'ua_invoice'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_STATUSES = ['draft', 'checked', 'sent'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const currency = z.enum(['USD', 'EUR']).default('USD');

/** Units a line can be measured in (weights in a packing list stay kg). */
export const UNITS = ['kg', 't', 'pcs', 'l', 'm2'] as const;
export type Unit = (typeof UNITS)[number];
const unit = z.enum(UNITS).catch('kg').default('kg');

/** A company as the documents print it, in both languages. */
export const partySchema = z.object({
  nameEn: s(300),           // "NOVOVETTEKH" LLC
  nameUk: s(300),           // ТОВ «НОВОВЕТТЕХ»
  countryEn: s(100),        // Ukraine
  countryUk: s(100),        // Україна
  signatoryEn: s(300),      // Director Abramova Alina
  signatoryUk: s(300),      // Директора Абрамової Аліни (родовий відмінок: «в особі …»)
  basisEn: s(200),          // Statute
  basisUk: s(200),          // Статуту
  addressEn: s(1000),       // for «Consignee» and invoice «To:»
  addressUk: s(1000),
  requisitesEn: block,      // address + codes + bank, line per line
  requisitesUk: block,
  code: s(20),              // contract-number suffix, e.g. PNS
});
export type Party = z.infer<typeof partySchema>;

export const PARTY_ROLES = ['seller', 'buyer', 'consignee', 'consignor', 'other'] as const;
export const directoryPartySchema = partySchema.extend({
  role: z.enum(PARTY_ROLES).default('buyer'),
  note: s(500),
  /** A seller's own invoice template (letterhead), from doc_templates. */
  invoiceTemplateId: z.string().uuid().nullable().catch(null).default(null),
});

/** A product line in the catalogue / in a contract specification. */
export const productSchema = z.object({
  nameEn: s(500),
  nameUk: s(500),
  hs: s(20),
  reg: s(200),              // Ukrainian registration («UA/18432/01/01 не обмежена з 11.04.2025»)
  manufacturer: s(300),
  countryEn: s(100),
  countryUk: s(100),
  unit,
});
export type Product = z.infer<typeof productSchema>;

const num = z.coerce.number().finite().min(0).max(1e12).default(0);
const days = (d: number) => z.coerce.number().int().min(0).max(3650).default(d);

export const contractItemSchema = productSchema.extend({ qty: num, price: num });
export type ContractItem = z.infer<typeof contractItemSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')).default('');
const templateId = z.string().uuid().nullable().catch(null).default(null);

/** How the buyer pays — each variant is its own wording of clause 4.1. */
export const PAYMENT_TYPES = ['deferred', 'prepay_full', 'prepay_part', 'lc'] as const;
const paymentFields = {
  paymentType: z.enum(PAYMENT_TYPES).catch('deferred').default('deferred'),
  /** deferred / the rest of a part prepayment: days after delivery. */
  paymentDays: days(90),
  /** prepayment / letter of credit: days from the invoice (or signing). */
  prepayDays: days(5),
  prepayPercent: z.coerce.number().min(1).max(99).catch(30).default(30),
};

const deliveryFields = {
  currency,
  incoterm: s(10).transform((v) => v || 'CPT'),
  incoPlaceEn: s(200),
  incoPlaceUk: s(200),
  incoYear: s(4).transform((v) => v || '2020'),
  deliveryDays: days(60),
};

export const contractDataSchema = z.object({
  number: s(100),
  date: isoDate,
  signPlaceEn: s(100).transform((v) => v || 'Ukraine, Kharkiv'),
  signPlaceUk: s(100).transform((v) => v || 'Україна, Харків'),
  seller: partySchema.default({}),
  buyer: partySchema.default({}),
  /** null → the buyer is the consignee. */
  consignee: partySchema.nullable().default(null),
  /** null → «The Consignor … will be informed additionally». */
  consignor: partySchema.nullable().default(null),
  goodsEn: s(200).transform((v) => v || 'substances'),
  goodsUk: s(200).transform((v) => v || 'субстанції'),
  ...deliveryFields,
  ...paymentFields,
  showReg: z.boolean().default(false),
  items: z.array(contractItemSchema).max(100).default([]),
  templateId,
});
export type ContractData = z.infer<typeof contractDataSchema>;

/** «ANNEX No. 21 dated … TO THE CONTRACT No. … dated …» — a delivery under a long contract. */
export const appendixDataSchema = z.object({
  number: s(20),            // the annex number, «21»
  date: isoDate,
  contractNumber: s(100),
  contractDate: isoDate,
  signPlaceEn: s(100).transform((v) => v || 'Ukraine, Kharkiv'),
  signPlaceUk: s(100).transform((v) => v || 'Україна, Харків'),
  seller: partySchema.default({}),
  buyer: partySchema.default({}),
  consignor: partySchema.nullable().default(null),
  ...deliveryFields,
  ...paymentFields,
  showReg: z.boolean().default(false),
  items: z.array(contractItemSchema).max(100).default([]),
  templateId,
});
export type AppendixData = z.infer<typeof appendixDataSchema>;

export const invoiceItemSchema = z.object({
  nameEn: s(500),
  reg: s(200),
  manufacturer: s(300),
  countryEn: s(100),
  unit,
  qty: num,
  price: num,
});

export const batchSchema = z.object({
  nameEn: s(500),
  reg: s(200),
  batch: s(200),
  net: num,
  gross: num,
  packages: s(200),          // «10 X 50 KG BALES», «3 pallets (40 drums)»
  packagesCount: num,        // what the TOTAL row sums
});

export const invoiceDataSchema = z.object({
  number: s(100),
  date: isoDate,
  /** «31072026/PNS dated July 31, 2026» — or an appendix reference. */
  contractRef: s(500),
  toName: s(300),
  toAddress: s(1000),
  consignorName: s(300),
  consignorAddress: s(1000),
  currency,
  incoterm: s(10).transform((v) => v || 'CPT'),
  incoPlaceEn: s(200),
  incoYear: s(4).transform((v) => v || '2020'),
  originEn: s(200),
  pallets: s(200),
  stamp: z.boolean().default(true),
  items: z.array(invoiceItemSchema).max(100).default([]),
  batches: z.array(batchSchema).max(200).default([]),
  templateId,
});
export type InvoiceData = z.infer<typeof invoiceDataSchema>;

/** Ukrainian domestic sale: видаткова накладна or рахунок на оплату (UAH, with VAT). */
export const UA_UNITS = ['кг', 'т', 'шт', 'л', 'м²', 'уп', 'послуга'] as const;
export const uaItemSchema = z.object({
  name: s(500),
  unit: z.enum(UA_UNITS).catch('кг').default('кг'),
  qty: num,
  price: num,               // without VAT
});

export const uaInvoiceDataSchema = z.object({
  docType: z.enum(['nakladna', 'rahunok']).catch('nakladna').default('nakladna'),
  number: s(100),
  date: isoDate,
  place: s(100).transform((v) => v || 'м. Харків'),
  seller: partySchema.default({}),
  buyer: partySchema.default({}),
  /** «Договір поставки № 12 від 01.10.2026». */
  basis: s(300),
  vatRate: z.coerce.number().refine((v) => v === 0 || v === 7 || v === 20).catch(20).default(20),
  sellerSigner: s(200),
  buyerSigner: s(200),
  items: z.array(uaItemSchema).max(200).default([]),
  templateId,
});
export type UaInvoiceData = z.infer<typeof uaInvoiceDataSchema>;

export type DocData = ContractData | AppendixData | InvoiceData | UaInvoiceData;

const SCHEMAS = {
  contract: contractDataSchema,
  appendix: appendixDataSchema,
  invoice: invoiceDataSchema,
  ua_invoice: uaInvoiceDataSchema,
} as const;

export function parseData(kind: 'contract', data: unknown): ContractData;
export function parseData(kind: 'appendix', data: unknown): AppendixData;
export function parseData(kind: 'invoice', data: unknown): InvoiceData;
export function parseData(kind: 'ua_invoice', data: unknown): UaInvoiceData;
export function parseData(kind: DocKind, data: unknown): DocData;
export function parseData(kind: DocKind, data: unknown): DocData {
  return SCHEMAS[kind].parse(data ?? {});
}
