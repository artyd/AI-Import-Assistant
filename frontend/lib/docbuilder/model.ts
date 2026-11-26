// Document builder (spec 012) — the shapes the backend stores (src/docbuilder/schema.ts)
// and the pure helpers the editor needs. No React here, so it is unit-tested.

export type DocKind = "contract" | "invoice";
export type Currency = "USD" | "EUR";
export type PartyRole = "seller" | "buyer" | "consignor" | "other";

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
}

export interface Product {
  nameEn: string;
  nameUk: string;
  hs: string;
  reg: string;
  manufacturer: string;
  countryEn: string;
  countryUk: string;
}

export interface DirectoryProduct extends Product {
  id: string;
}

export interface ContractItem extends Product {
  qty: number;
  price: number;
}

export interface ContractData {
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
  paymentDays: number;
  showReg: boolean;
  items: ContractItem[];
}

export interface InvoiceItem {
  nameEn: string;
  reg: string;
  manufacturer: string;
  countryEn: string;
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
}

export type DocData = ContractData | InvoiceData;

export interface DocSummary {
  id: string;
  kind: DocKind;
  number: string;
  title: string;
  contractId: string | null;
  date: string;
  currency: Currency;
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
  return { nameEn: "", nameUk: "", hs: "", reg: "", manufacturer: "", countryEn: "", countryUk: "" };
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
    paymentDays: 90,
    showReg: false,
    items: [],
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
  };
}

export function itemFromProduct(p: Product): ContractItem {
  return { ...emptyProduct(), ...p, qty: 0, price: 0 };
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

export function lineTotal(qty: number, price: number): number {
  return r2((Number(qty) || 0) * (Number(price) || 0));
}

export function itemsTotal(items: { qty: number; price: number }[]): number {
  return r2(items.reduce((s, i) => s + lineTotal(i.qty, i.price), 0));
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

/**
 * Packing-list check: per product, the batches' net weight should equal the
 * invoiced quantity (kg). Returns human lines for every mismatch.
 */
export function packingMismatches(d: InvoiceData): string[] {
  const out: string[] = [];
  for (const it of d.items) {
    const name = it.nameEn.trim();
    if (!name) continue;
    const net = r3(d.batches.filter((b) => b.nameEn.trim() === name).reduce((s, b) => s + (Number(b.net) || 0), 0));
    if (net !== r3(Number(it.qty) || 0)) out.push(`${name}: в інвойсі ${fmtNum(it.qty)} кг, у пакувальному листі нетто ${fmtNum(net)} кг`);
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
