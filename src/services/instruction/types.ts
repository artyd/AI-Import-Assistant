import { z } from 'zod';

/**
 * Supplier-instruction draft — the structured state of the constructor screen
 * (docs/instruction-builder-and-report/TZ.md §1). Stored per version as JSONB;
 * the letter text is ALWAYS rendered from it by `render.ts` (deterministic, no
 * LLM), and the approved version drives the instruction-compliance check.
 */

export const CATEGORIES = ['substance', 'finished', 'chemical', 'food', 'other'] as const;
export const TRANSPORTS = ['air', 'sea', 'road', 'multimodal'] as const;

/** Where a field's value came from — shown as a badge next to the field. */
export const SOURCES = ['contract', 'invoice', 'documents', 'parties', 'template', 'qdpro', 'pubchem', 'previous', 'manual'] as const;
export type FieldSource = (typeof SOURCES)[number];

/** Bounded text field — a draft is stored per version, previewed live and sent to the refine model. */
const str = (max = 1000) => z.string().max(max).default('');

const party = z.object({
  name: str(),
  address: str(),
  country: str(),
});

const checkItem = z.object({
  key: z.string().max(64),
  label: z.string().max(300), // English label as it appears in the letter
  labelUk: str(),
  checked: z.boolean(),
  source: z.enum(['base', 'qdpro', 'previous', 'custom']).default('base'),
});

export const draftSchema = z.object({
  from: z.object({
    directoryId: z.string().max(64).nullable().default(null),
    name: str(),
    address: str(),
    signer: str(),
    email: str(),
    phone: str(),
  }),
  category: z.enum(CATEGORIES).default('substance'),
  product: z.object({
    name: str(),
    grade: str(),
    cas: str(),
    quantity: str(),
    unit: z.string().default('kg'),
    hsCode: str(),
    regNumber: str(),
  }),
  consignor: party,
  consigneeChoice: z.enum(['intermediary', 'recipient', 'custom']).default('recipient'),
  consignee: party,
  finalConsignee: str(),
  contract: z.object({ number: str(), date: str() }),
  terms: z.object({
    incoterm: str(),
    place: str(),
    destination: str(), // port / airport of destination
    finalDestination: str(),
    transport: z.enum(TRANSPORTS).default('air'),
  }),
  docs: z.array(checkItem).max(60).default([]),
  labels: z.array(checkItem).max(60).default([]),
  labelNotes: str(),
  originals: z.object({
    contact: str(),
    phone: str(),
    address: str(),
  }),
  supplierEmail: str(),
  /** Extra clauses accepted from «Доопрацювати з ШІ» (rendered as section 7). */
  extra: z.array(z.object({ en: z.string().max(2000), uk: z.string().max(2000) })).max(10).default([]),
  /** Field path → where the value came from (badges). */
  sources: z.record(z.enum(SOURCES)).default({}),
  /** Values Штурман proposed in chat, waiting for the user's accept/reject. */
  proposals: z
    .array(z.object({ path: z.string().max(64), value: z.string().max(500), reason: z.string().max(300) }))
    .max(30)
    .default([]),
  /** Context shown as hints (not rendered into the letter). */
  hints: z
    .object({
      contractType: z.enum(['bilateral', 'trilateral']).nullable().default(null),
      intermediary: str(),
      recipient: str(),
      qdproSummary: str(),
      lessons: z.array(z.string().max(300)).max(10).default([]),
    })
    .default({}),
});

export type InstructionDraft = z.infer<typeof draftSchema>;
export type CheckItem = z.infer<typeof checkItem>;

/**
 * The ONLY paths Штурман may propose and the screen may set from a proposal —
 * never derived from user/model input (blocks prototype paths like
 * `constructor.name` and edits of hints/checklists via prompt injection).
 */
export const PROPOSABLE_PATHS = [
  'from.name', 'from.address', 'from.signer', 'from.email', 'from.phone',
  'product.name', 'product.grade', 'product.cas', 'product.quantity', 'product.hsCode', 'product.regNumber',
  'consignor.name', 'consignor.address', 'consignor.country',
  'consignee.name', 'consignee.address', 'consignee.country', 'finalConsignee',
  'contract.number', 'contract.date',
  'terms.incoterm', 'terms.place', 'terms.destination', 'terms.finalDestination',
  'labelNotes', 'originals.contact', 'originals.phone', 'originals.address', 'supplierEmail',
] as const;
export const isProposablePath = (p: string): boolean => (PROPOSABLE_PATHS as readonly string[]).includes(p);

/** Fields that must be filled before approve / export (path → human label). */
export const REQUIRED_FIELDS: Record<string, string> = {
  'from.name': 'Від імені — компанія',
  'product.name': 'Назва товару',
  'product.quantity': 'Кількість',
  'consignor.name': 'Відправник',
  'consignee.name': 'Одержувач',
  'contract.number': 'Номер контракту',
  'terms.incoterm': 'Incoterms',
  'terms.place': 'Місце відвантаження',
  'originals.contact': 'Контакт для оригіналів',
  'originals.phone': 'Телефон для оригіналів',
  'originals.address': 'Адреса для оригіналів',
};

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const clone = structuredClone(obj) as Record<string, unknown>;
  let cur = clone;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    if (!next || typeof next !== 'object') return obj; // unknown path — ignore
    cur = next as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  if (!(last in cur)) return obj;
  cur[last] = value;
  return clone as T;
}

export function missingFields(d: InstructionDraft): { path: string; label: string }[] {
  return Object.entries(REQUIRED_FIELDS)
    .filter(([path]) => {
      const v = getPath(d, path);
      return typeof v !== 'string' || !v.trim();
    })
    .map(([path, label]) => ({ path, label }));
}
