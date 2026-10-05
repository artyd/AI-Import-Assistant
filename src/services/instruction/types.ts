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

const party = z.object({
  name: z.string().default(''),
  address: z.string().default(''),
  country: z.string().default(''),
});

const checkItem = z.object({
  key: z.string(),
  label: z.string(), // English label as it appears in the letter
  labelUk: z.string().default(''),
  checked: z.boolean(),
  source: z.enum(['base', 'qdpro', 'previous', 'custom']).default('base'),
});

export const draftSchema = z.object({
  from: z.object({
    directoryId: z.string().nullable().default(null),
    name: z.string().default(''),
    address: z.string().default(''),
    signer: z.string().default(''),
    email: z.string().default(''),
    phone: z.string().default(''),
  }),
  category: z.enum(CATEGORIES).default('substance'),
  product: z.object({
    name: z.string().default(''),
    grade: z.string().default(''),
    cas: z.string().default(''),
    quantity: z.string().default(''),
    unit: z.string().default('kg'),
    hsCode: z.string().default(''),
    regNumber: z.string().default(''),
  }),
  consignor: party,
  consigneeChoice: z.enum(['intermediary', 'recipient', 'custom']).default('recipient'),
  consignee: party,
  finalConsignee: z.string().default(''),
  contract: z.object({ number: z.string().default(''), date: z.string().default('') }),
  terms: z.object({
    incoterm: z.string().default(''),
    place: z.string().default(''),
    destination: z.string().default(''), // port / airport of destination
    finalDestination: z.string().default(''),
    transport: z.enum(TRANSPORTS).default('air'),
  }),
  docs: z.array(checkItem).default([]),
  labels: z.array(checkItem).default([]),
  labelNotes: z.string().default(''),
  originals: z.object({
    contact: z.string().default(''),
    phone: z.string().default(''),
    address: z.string().default(''),
  }),
  supplierEmail: z.string().default(''),
  /** Extra clauses accepted from «Доопрацювати з ШІ» (rendered as section 7). */
  extra: z.array(z.object({ en: z.string(), uk: z.string() })).default([]),
  /** Field path → where the value came from (badges). */
  sources: z.record(z.enum(SOURCES)).default({}),
  /** Values Штурман proposed in chat, waiting for the user's accept/reject. */
  proposals: z
    .array(z.object({ path: z.string(), value: z.string(), reason: z.string() }))
    .default([]),
  /** Context shown as hints (not rendered into the letter). */
  hints: z
    .object({
      contractType: z.enum(['bilateral', 'trilateral']).nullable().default(null),
      intermediary: z.string().default(''),
      recipient: z.string().default(''),
      qdproSummary: z.string().default(''),
      lessons: z.array(z.string()).default([]),
    })
    .default({}),
});

export type InstructionDraft = z.infer<typeof draftSchema>;
export type CheckItem = z.infer<typeof checkItem>;

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
