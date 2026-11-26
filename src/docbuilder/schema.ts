import { z } from 'zod';

/**
 * Document builder (spec 012) — the data a logist assembles a trade document
 * from. A document stores SNAPSHOTS of its parties and goods, so editing the
 * directory later never rewrites a document that was already sent.
 */
const s = (max = 500) => z.string().trim().max(max).default('');
const block = s(3000); // multi-line requisites

export const DOC_KINDS = ['contract', 'invoice'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const currency = z.enum(['USD', 'EUR']).default('USD');

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

export const PARTY_ROLES = ['seller', 'buyer', 'consignor', 'other'] as const;
export const directoryPartySchema = partySchema.extend({
  role: z.enum(PARTY_ROLES).default('buyer'),
  note: s(500),
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
});
export type Product = z.infer<typeof productSchema>;

const num = z.coerce.number().finite().min(0).max(1e12).default(0);

export const contractItemSchema = productSchema.extend({ qty: num, price: num });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')).default('');

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
  currency,
  incoterm: s(10).transform((v) => v || 'CPT'),
  incoPlaceEn: s(200),
  incoPlaceUk: s(200),
  incoYear: s(4).transform((v) => v || '2020'),
  deliveryDays: z.coerce.number().int().min(0).max(3650).default(60),
  paymentDays: z.coerce.number().int().min(0).max(3650).default(90),
  showReg: z.boolean().default(false),
  items: z.array(contractItemSchema).max(100).default([]),
});
export type ContractData = z.infer<typeof contractDataSchema>;

export const invoiceItemSchema = z.object({
  nameEn: s(500),
  reg: s(200),
  manufacturer: s(300),
  countryEn: s(100),
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
});
export type InvoiceData = z.infer<typeof invoiceDataSchema>;

export function parseData(kind: DocKind, data: unknown): ContractData | InvoiceData {
  return kind === 'contract' ? contractDataSchema.parse(data ?? {}) : invoiceDataSchema.parse(data ?? {});
}
