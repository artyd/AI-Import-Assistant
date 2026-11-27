// Document builder (spec 012) — the shapes the backend stores (src/docbuilder/schema.ts)
// and the pure helpers the editor needs. No React here, so it is unit-tested.

export type DocKind = "contract" | "appendix" | "invoice" | "ua_invoice";
export type Currency = "USD" | "EUR";
export type PartyRole = "seller" | "buyer" | "consignee" | "consignor" | "other";
export type DocStatus = "draft" | "checked" | "sent";
export type Unit = "kg" | "t" | "pcs" | "l" | "m2";
export type PaymentType = "deferred" | "prepay_full" | "prepay_part" | "lc";

export const KIND_LABEL: Record<DocKind, string> = {
  contract: "Контракт",
  appendix: "Додаток",
  invoice: "Інвойс",
  ua_invoice: "Накладна / рахунок",
};

export const KIND_SUBTITLE: Record<DocKind, string> = {
  contract: "Контракт + Специфікація",
  appendix: "Додаток (специфікація) до контракту",
  invoice: "Інвойс + Пакувальний лист",
  ua_invoice: "Видаткова накладна / Рахунок на оплату (грн)",
};

export const STATUS_LABEL: Record<DocStatus, string> = { draft: "Чернетка", checked: "Перевірено", sent: "Відправлено" };

export const UNIT_OPTIONS: { value: Unit; label: string }[] = [
  { value: "kg", label: "кг" },
  { value: "t", label: "т" },
  { value: "pcs", label: "шт" },
  { value: "l", label: "л" },
  { value: "m2", label: "м²" },
];
export const unitLabel = (u: Unit) => UNIT_OPTIONS.find((o) => o.value === u)?.label ?? u;

export const UA_UNITS = ["кг", "т", "шт", "л", "м²", "уп", "послуга"] as const;
export type UaUnit = (typeof UA_UNITS)[number];

export const PAYMENT_OPTIONS: { value: PaymentType; label: string }[] = [
  { value: "deferred", label: "Відстрочка після поставки" },
  { value: "prepay_full", label: "100% передоплата" },
  { value: "prepay_part", label: "Часткова передоплата + решта після поставки" },
  { value: "lc", label: "Акредитив" },
];

export interface Finding {
  level: "error" | "warning" | "ok";
  area: string;
  message: string;
}

export interface TemplateInfo {
  id: string;
  kind: DocKind;
  name: string;
  createdAt: string;
}

export interface DocEvent {
  action: string;
  note: string;
  at: string;
  user: string;
}

export interface Party {
  nameEn: string;
  nameUk: string;
  countryEn: string;
  countryUk: string;
  signatoryEn: string;
  signatoryUk: string;
  basisEn: string;
  basisUk: string;
  addressEn: string;
  addressUk: string;
  requisitesEn: string;
  requisitesUk: string;
  code: string;
}

export interface DirectoryParty extends Party {
  id: string;
  role: PartyRole;
  note: string;
  invoiceTemplateId?: string | null;
}

export interface Product {
  nameEn: string;
  nameUk: string;
  hs: string;
  reg: string;
  manufacturer: string;
  countryEn: string;
  countryUk: string;
  unit: Unit;
}

export interface DirectoryProduct extends Product {
  id: string;
}

export interface ContractItem extends Product {
  qty: number;
  price: number;
}

interface PaymentFields {
  paymentType: PaymentType;
  paymentDays: number;
  prepayDays: number;
  prepayPercent: number;
}

export interface ContractData extends PaymentFields {
  number: string;
  date: string;
  signPlaceEn: string;
  signPlaceUk: string;
  seller: Party;
  buyer: Party;
  consignee: Party | null;
  consignor: Party | null;
  goodsEn: string;
  goodsUk: string;
  currency: Currency;
  incoterm: string;
  incoPlaceEn: string;
  incoPlaceUk: string;
  incoYear: string;
  deliveryDays: number;
  showReg: boolean;
  items: ContractItem[];
  templateId: string | null;
}

export interface AppendixData extends PaymentFields {
  number: string;
  date: string;
  contractNumber: string;
  contractDate: string;
  signPlaceEn: string;
  signPlaceUk: string;
  seller: Party;
  buyer: Party;
  consignor: Party | null;
  currency: Currency;
  incoterm: string;
  incoPlaceEn: string;
  incoPlaceUk: string;
  incoYear: string;
  deliveryDays: number;
  showReg: boolean;
  items: ContractItem[];
  templateId: string | null;
}

export interface InvoiceItem {
  nameEn: string;
  reg: string;
  manufacturer: string;
  countryEn: string;
  unit: Unit;
  qty: number;
  price: number;
}

export interface Batch {
  nameEn: string;
  reg: string;
  batch: string;
  net: number;
  gross: number;
  packages: string;
  packagesCount: number;
}

export interface InvoiceData {
  number: string;
  date: string;
  contractRef: string;
  toName: string;
  toAddress: string;
  consignorName: string;
  consignorAddress: string;
  currency: Currency;
  incoterm: string;
  incoPlaceEn: string;
  incoYear: string;
  originEn: string;
  pallets: string;
  stamp: boolean;
  items: InvoiceItem[];
  batches: Batch[];
  templateId: string | null;
}

export interface UaItem {
  name: string;
  unit: UaUnit;
  qty: number;
  price: number;
}

export interface UaInvoiceData {
  docType: "nakladna" | "rahunok";
  number: string;
  date: string;
  place: string;
  seller: Party;
  buyer: Party;
  basis: string;
  vatRate: number;
  sellerSigner: string;
  buyerSigner: string;
  items: UaItem[];
  templateId: string | null;
}

export type DocData = ContractData | AppendixData | InvoiceData | UaInvoiceData;

export interface DocSummary {
  id: string;
  kind: DocKind;
  number: string;
  title: string;
  contractId: string | null;
  status: DocStatus;
  version: number;
  parentId: string | null;
  date: string;
  currency: string;
  total: number;
  updatedAt: string;
}

export interface DocFull {
  id: string;
  kind: DocKind;
  number: string;
  title: string;
  data: DocData;
  contractId: string | null;
  status: DocStatus;
  version: number;
  parentId: string | null;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const GOODS_PRESETS: { en: string; uk: string; label: string }[] = [
  { en: "substances", uk: "субстанції", label: "субстанції" },
  { en: "pharmaceutical substances", uk: "фармацевтичні субстанції", label: "фармацевтичні субстанції" },
];

export const INCOTERMS = ["CPT", "CIP", "DAP", "DDP", "FCA", "EXW", "CFR", "CIF", "FOB"];

export function emptyParty(): Party {
  return {
    nameEn: "", nameUk: "", countryEn: "", countryUk: "", signatoryEn: "", signatoryUk: "",
    basisEn: "", basisUk: "", addressEn: "", addressUk: "", requisitesEn: "", requisitesUk: "", code: "",
  };
}

export function emptyProduct(): Product {
  return { nameEn: "", nameUk: "", hs: "", reg: "", manufacturer: "", countryEn: "", countryUk: "", unit: "kg" };
}

/** A directory entry → the snapshot a document stores (drops id/role/note). */
export function snapshot(p: DirectoryParty | Party): Party {
  const e = emptyParty();
  const out = { ...e };
  for (const k of Object.keys(e) as (keyof Party)[]) out[k] = (p as Party)[k] ?? "";
  return out;
}

export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** «31072026/PNS» — the team's convention: contract date + the buyer's suffix. */
export function contractNumber(dateIso: string, code: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!m) return "";
  const base = `${m[3]}${m[2]}${m[1]}`;
  return code.trim() ? `${base}/${code.trim()}` : base;
}

/** True when the number is still the auto one (so a date/buyer change may refresh it). */
export function isAutoNumber(number: string): boolean {
  return number.trim() === "" || /^\d{8}(\/[A-Za-z0-9-]+)?$/.test(number.trim());
}

const PAYMENT_DEFAULTS: PaymentFields = { paymentType: "deferred", paymentDays: 90, prepayDays: 5, prepayPercent: 30 };

export function emptyContract(seller: Party | null, today = todayIso()): ContractData {
  return {
    number: contractNumber(today, ""),
    date: today,
    signPlaceEn: "Ukraine, Kharkiv",
    signPlaceUk: "Україна, Харків",
    seller: seller ? snapshot(seller) : emptyParty(),
    buyer: emptyParty(),
    consignee: null,
    consignor: null,
    goodsEn: "substances",
    goodsUk: "субстанції",
    currency: "USD",
    incoterm: "CPT",
    incoPlaceEn: "Bila Tserkva, Ukraine",
    incoPlaceUk: "Біла Церква, Україна",
    incoYear: "2020",
    deliveryDays: 60,
    ...PAYMENT_DEFAULTS,
    showReg: false,
    items: [],
    templateId: null,
  };
}

export function emptyInvoice(seller: Party | null, today = todayIso()): InvoiceData {
  return {
    number: "",
    date: today,
    contractRef: "",
    toName: "",
    toAddress: "",
    consignorName: seller?.nameEn ?? "",
    consignorAddress: seller?.addressEn ?? "",
    currency: "USD",
    incoterm: "CPT",
    incoPlaceEn: "Bila Tserkva, Ukraine",
    incoYear: "2020",
    originEn: "",
    pallets: "",
    stamp: true,
    items: [],
    batches: [],
    templateId: null,
  };
}

export function emptyUaInvoice(seller: Party | null, today = todayIso()): UaInvoiceData {
  return {
    docType: "nakladna",
    number: "",
    date: today,
    place: "м. Харків",
    seller: seller ? snapshot(seller) : emptyParty(),
    buyer: emptyParty(),
    basis: "",
    vatRate: 20,
    sellerSigner: "",
    buyerSigner: "",
    items: [],
    templateId: null,
  };
}

export function itemFromProduct(p: Product): ContractItem {
  const clean = emptyProduct();
  const src = p as unknown as Record<string, unknown>;
  const out = clean as unknown as Record<string, unknown>;
  for (const k of Object.keys(clean)) if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  return { ...clean, qty: 0, price: 0 };
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

export function lineTotal(qty: number, price: number): number {
  return r2((Number(qty) || 0) * (Number(price) || 0));
}

export function itemsTotal(items: { qty: number; price: number }[]): number {
  return r2(items.reduce((s, i) => s + lineTotal(i.qty, i.price), 0));
}

export function uaTotals(d: { items: { qty: number; price: number }[]; vatRate: number }): { net: number; vat: number; total: number } {
  const net = itemsTotal(d.items);
  const vat = r2((net * d.vatRate) / 100);
  return { net, vat, total: r2(net + vat) };
}

export function docTotal(kind: DocKind, d: DocData): number {
  return kind === "ua_invoice" ? uaTotals(d as UaInvoiceData).total : itemsTotal((d as ContractData).items);
}

export function docCurrency(kind: DocKind, d: DocData): string {
  return kind === "ua_invoice" ? "грн" : (d as ContractData).currency;
}

export function batchTotals(batches: Batch[]): { net: number; gross: number; packages: number } {
  return batches.reduce(
    (a, b) => ({
      net: r3(a.net + (Number(b.net) || 0)),
      gross: r3(a.gross + (Number(b.gross) || 0)),
      packages: r3(a.packages + (Number(b.packagesCount) || 0)),
    }),
    { net: 0, gross: 0, packages: 0 },
  );
}

/** Invoiced quantity in kg (tonnes converted); null for pieces / litres / m². */
function kgOf(qty: number, unit: Unit | undefined): number | null {
  if (!unit || unit === "kg") return Number(qty) || 0;
  if (unit === "t") return (Number(qty) || 0) * 1000;
  return null;
}

/**
 * Packing-list check: per product sold by weight, the batches' net weight should
 * equal the invoiced quantity. Returns human lines for every mismatch.
 */
export function packingMismatches(d: InvoiceData): string[] {
  const out: string[] = [];
  for (const it of d.items) {
    const name = it.nameEn.trim();
    const kg = kgOf(it.qty, it.unit);
    if (!name || kg === null) continue;
    const net = r3(d.batches.filter((b) => b.nameEn.trim() === name).reduce((s, b) => s + (Number(b.net) || 0), 0));
    if (net !== r3(kg)) out.push(`${name}: в інвойсі ${fmtNum(kg)} кг, у пакувальному листі нетто ${fmtNum(net)} кг`);
  }
  return out;
}

/** «25 010,00» */
export function fmtMoney(n: number): string {
  return (Number(n) || 0).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtNum(n: number): string {
  return (Number(n) || 0).toLocaleString("uk-UA", { maximumFractionDigits: 3 });
}

/** What still blocks a clean document — shown above the download button, never blocking it. */
export function contractGaps(d: ContractData): string[] {
  const g: string[] = [];
  if (!d.number.trim()) g.push("номер контракту");
  if (!d.date) g.push("дата");
  if (!d.seller.nameEn.trim()) g.push("продавець");
  if (!d.buyer.nameEn.trim()) g.push("покупець");
  if (!d.buyer.signatoryEn.trim() || !d.buyer.signatoryUk.trim()) g.push("підписант покупця (EN і UA)");
  if (!d.buyer.requisitesEn.trim()) g.push("реквізити покупця");
  if (!d.incoPlaceEn.trim() || !d.incoPlaceUk.trim()) g.push("місце поставки (EN і UA)");
  if (d.items.length === 0) g.push("товари специфікації");
  d.items.forEach((it, i) => {
    if (!it.nameEn.trim()) g.push(`назва товару №${i + 1}`);
    if (!(it.qty > 0) || !(it.price > 0)) g.push(`кількість і ціна товару №${i + 1}`);
  });
  if (d.showReg && d.items.some((it) => !it.reg.trim())) g.push("українська реєстрація для всіх товарів");
  return g;
}

export function appendixGaps(d: AppendixData): string[] {
  const g: string[] = [];
  if (!d.number.trim()) g.push("номер додатку");
  if (!d.contractNumber.trim()) g.push("номер контракту");
  if (!d.contractDate) g.push("дата контракту");
  if (!d.seller.nameEn.trim()) g.push("продавець");
  if (!d.buyer.nameEn.trim()) g.push("покупець");
  if (d.items.length === 0) g.push("товари специфікації");
  d.items.forEach((it, i) => {
    if (!it.nameEn.trim()) g.push(`назва товару №${i + 1}`);
    if (!(it.qty > 0) || !(it.price > 0)) g.push(`кількість і ціна товару №${i + 1}`);
  });
  return g;
}

export function invoiceGaps(d: InvoiceData): string[] {
  const g: string[] = [];
  if (!d.number.trim()) g.push("номер інвойсу");
  if (!d.contractRef.trim()) g.push("посилання на контракт");
  if (!d.toName.trim()) g.push("одержувач (To:)");
  if (d.items.length === 0) g.push("товари");
  if (d.batches.length === 0) g.push("партії пакувального листа");
  if (d.batches.some((b) => !b.batch.trim())) g.push("номери партій");
  if (d.batches.some((b) => !(b.gross > 0))) g.push("вага брутто");
  return [...g, ...packingMismatches(d)];
}

export function uaInvoiceGaps(d: UaInvoiceData): string[] {
  const g: string[] = [];
  if (!d.number.trim()) g.push("номер");
  if (!(d.seller.nameUk || d.seller.nameEn).trim()) g.push("постачальник");
  if (!(d.buyer.nameUk || d.buyer.nameEn).trim()) g.push("покупець");
  if (!d.seller.requisitesUk.trim() && !d.seller.requisitesEn.trim()) g.push("реквізити постачальника");
  if (d.items.length === 0) g.push("товари");
  d.items.forEach((it, i) => {
    if (!it.name.trim()) g.push(`назва рядка №${i + 1}`);
    if (!(it.qty > 0) || !(it.price > 0)) g.push(`кількість і ціна рядка №${i + 1}`);
  });
  return g;
}

export function gapsFor(kind: DocKind, d: DocData): string[] {
  switch (kind) {
    case "contract":
      return contractGaps(d as ContractData);
    case "appendix":
      return appendixGaps(d as AppendixData);
    case "invoice":
      return invoiceGaps(d as InvoiceData);
    default:
      return uaInvoiceGaps(d as UaInvoiceData);
  }
}

/** History line in Ukrainian. */
export function eventLabel(e: DocEvent): string {
  const map: Record<string, string> = {
    created: "створено",
    edited: "редагування",
    version: "нова версія",
    to_shipment: "збережено в постачання",
    "status:draft": "повернуто в чернетку",
    "status:checked": "позначено «Перевірено»",
    "status:sent": "позначено «Відправлено»",
  };
  return [map[e.action] ?? e.action, e.note].filter(Boolean).join(" — ");
}
