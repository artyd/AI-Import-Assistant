// Supplier-instruction builder — client types mirroring the backend draft schema
// (src/services/instruction/types.ts). The letter itself is rendered server-side
// (POST /instruction/preview) so EN/UK text, DOCX and PDF never drift apart.

export type Category = "substance" | "finished" | "chemical" | "food" | "other";
export type Transport = "air" | "sea" | "road" | "multimodal";
export type FieldSource =
  | "contract" | "invoice" | "documents" | "parties" | "template" | "qdpro" | "pubchem" | "previous" | "manual";

export interface CheckItem {
  key: string;
  label: string;
  labelUk: string;
  checked: boolean;
  source: "base" | "qdpro" | "previous" | "custom";
}
export interface PartyFields {
  name: string;
  address: string;
  country: string;
}

export interface InstructionDraft {
  from: { directoryId: string | null; name: string; address: string; signer: string; email: string; phone: string };
  category: Category;
  product: { name: string; grade: string; cas: string; quantity: string; unit: string; hsCode: string; regNumber: string };
  consignor: PartyFields;
  consigneeChoice: "intermediary" | "recipient" | "custom";
  consignee: PartyFields;
  finalConsignee: string;
  contract: { number: string; date: string };
  terms: { incoterm: string; place: string; destination: string; finalDestination: string; transport: Transport };
  docs: CheckItem[];
  labels: CheckItem[];
  labelNotes: string;
  originals: { contact: string; phone: string; address: string };
  supplierEmail: string;
  extra: { en: string; uk: string }[];
  sources: Record<string, FieldSource>;
  proposals: { path: string; value: string; reason: string }[];
  hints: {
    contractType: "bilateral" | "trilateral" | null;
    intermediary: string;
    recipient: string;
    qdproSummary: string;
    lessons: string[];
  };
}

export interface InstructionVersion {
  id: string;
  version: number;
  status: "draft" | "approved" | "sent";
  draft: InstructionDraft;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  missing: { path: string; label: string }[];
}

export interface DirectoryEntry {
  id: string;
  kind: "own_company" | "supplier" | "consignee" | "contact";
  name: string;
  address: string;
  country: string;
  signer: string;
  email: string;
  phone: string;
}

export const SOURCE_LABEL: Record<FieldSource, string> = {
  contract: "контракт",
  invoice: "інвойс",
  documents: "документи",
  parties: "сторони",
  template: "шаблон",
  qdpro: "qdpro",
  pubchem: "PubChem",
  previous: "попередня поставка",
  manual: "вручну",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  substance: "Субстанція (АФІ)",
  finished: "Готовий препарат",
  chemical: "Хімія",
  food: "Харчова / вет.",
  other: "Інше",
};

export const TRANSPORT_LABEL: Record<Transport, string> = {
  air: "✈ Авіа (MAWB / HAWB)",
  sea: "🚢 Море (B/L)",
  road: "🚚 Авто (CMR)",
  multimodal: "Мультимодальний",
};

export const INCOTERMS = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];

/** Paths a Штурман proposal may set (mirrors backend PROPOSABLE_PATHS). */
export const PROPOSABLE_PATHS = new Set([
  "from.name", "from.address", "from.signer", "from.email", "from.phone",
  "product.name", "product.grade", "product.cas", "product.quantity", "product.hsCode", "product.regNumber",
  "consignor.name", "consignor.address", "consignor.country",
  "consignee.name", "consignee.address", "consignee.country", "finalConsignee",
  "contract.number", "contract.date",
  "terms.incoterm", "terms.place", "terms.destination", "terms.finalDestination",
  "labelNotes", "originals.contact", "originals.phone", "originals.address", "supplierEmail",
]);

export function getPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Immutable set of a string field; records the source as manual unless given. */
export function setField(d: InstructionDraft, path: string, value: string, source: FieldSource = "manual"): InstructionDraft {
  if (!PROPOSABLE_PATHS.has(path) && path !== "product.unit") return d; // known string fields only
  const keys = path.split(".");
  const next = structuredClone(d) as unknown as Record<string, unknown>;
  let cur = next;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[keys[keys.length - 1]!] = value;
  const out = next as unknown as InstructionDraft;
  out.sources = { ...out.sources, [path]: source };
  return out;
}
