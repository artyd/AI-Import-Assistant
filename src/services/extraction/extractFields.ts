import {
  anthropic,
  MODEL,
  type ChatTool,
  type ChatContentBlockParam,
} from '../../anthropic/client.js';
import { config } from '../../config.js';
import type { FileType } from '../../domain/folders.js';

/**
 * Structured field extraction for a single document. Runs a non-streaming Claude
 * call with a FORCED tool so the model must return JSON matching our schema
 * (never free text). The result is stored in `document_extractions.extracted_fields`
 * and is the deterministic source for checklist + discrepancy computation — those
 * never re-read raw document text at answer time.
 *
 * Schema shape (MVP hybrid, plan Q30-C): a COMMON backbone (numbers/dates/parties/
 * totals) shared by all document types, plus targeted fields for the invoice /
 * packing-list — net/gross weights and a per-SKU `line_items` table that powers
 * row-level reconciliation. The model also self-reports a `field_confidence` map
 * for the verdict-driving fields and an `extraction_note` when the source is hard
 * to read; the pipeline downgrades confidence further for OCR/scan sources so the
 * verification screen (human-in-the-loop) can flag exactly what to double-check.
 *
 * Two entry points: `extractDocumentFieldsFromDocument` feeds the ORIGINAL file
 * (PDF/image) to Claude vision so figures and tables are read from the document
 * image itself — not from heuristically-reconstructed pdf-parse text, which
 * mangles multi-column customs tables and detaches numbers from their labels
 * (the main hallucination source). `extractDocumentFields` is the text path,
 * used for docx/xlsx/csv/md and as a fallback.
 */

export type DocType =
  | 'invoice'
  | 'purchase_order'
  | 'packing_list'
  | 'contract'
  | 'certificate_of_origin'
  | 'quality_certificate'
  | 'customs_declaration'
  | 'transport'
  | 'other';

const DOC_TYPES: readonly DocType[] = [
  'invoice',
  'purchase_order',
  'packing_list',
  'contract',
  'certificate_of_origin',
  'quality_certificate',
  'customs_declaration',
  'transport',
  'other',
];

export type Confidence = 'high' | 'medium' | 'low';
const CONFIDENCE_LEVELS: readonly Confidence[] = ['high', 'medium', 'low'];

/**
 * The verdict-driving fields the model rates for confidence. Kept small on
 * purpose: these are the values a wrong read would silently corrupt into a false
 * (or missed) discrepancy, so they are the ones the verification screen forces a
 * human to confirm when confidence is low.
 */
export const CONFIDENCE_FIELDS = [
  'invoice_number',
  'po_number',
  'contract_number',
  'total_value',
  'currency',
  'net_weight_kg',
  'gross_weight_kg',
  'total_weight_kg',
  'packages_count',
  'hs_code',
  'country_of_origin',
  'incoterm',
  'manufacturer',
  'registration_number',
] as const;
export type ConfidenceField = (typeof CONFIDENCE_FIELDS)[number];

export type FieldConfidence = Partial<Record<ConfidenceField, Confidence>>;

export interface ExtractedParty {
  name: string;
  role: string | null;
  country: string | null;
  address: string | null;
}

/** A single commodity row shared by invoice and packing list (row-level recon). */
export interface ExtractedLineItem {
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  amount: number | null;
  hs_code: string | null;
  batch_no: string | null;
}

export interface ExtractedFields {
  doc_type: DocType;
  // Additional document types this SAME file also represents — e.g. a combined
  // "invoice + packing list" (2-in-1) file. Lets the checklist mark both present
  // and reconciliation treat one file as two roles (plan: 2-in-1 handling).
  also_contains: DocType[];
  // ── Common backbone ──────────────────────────────────────────────────────
  po_number: string | null;
  invoice_number: string | null;
  contract_number: string | null;
  total_value: number | null;
  currency: string | null;
  hs_code: string | null;
  country_of_origin: string | null;
  buyer: string | null;
  seller: string | null;
  incoterm: string | null;
  // Manufacturer of the goods + any regulatory registration number (e.g. a
  // Ukrainian drug registration UA/xxxxx/xx/xx). Power cross-document consistency
  // and (Phase 6) the drug-registry cross-check.
  manufacturer: string | null;
  registration_number: string | null;
  // Dates (ISO yyyy-mm-dd where possible) — power the proactive risk engine
  // (expiry / deadline checks). Null when the document does not state them.
  document_date: string | null;
  expiry_date: string | null;
  shipment_date: string | null;
  delivery_deadline: string | null;
  parties: ExtractedParty[];
  // ── Invoice / packing-list targeted fields ───────────────────────────────
  // total_weight_kg kept for back-compat (legacy consumers); net/gross are the
  // precise split a packing list carries.
  total_weight_kg: number | null;
  net_weight_kg: number | null;
  gross_weight_kg: number | null;
  packages_count: number | null;
  line_items: ExtractedLineItem[];
  // ── Extraction metadata ──────────────────────────────────────────────────
  field_confidence: FieldConfidence;
  extraction_note: string | null;
}

// Text-path input clip. Generous so multi-page invoices don't lose tail-page
// fields (totals often sit on the last page). The vision path sends the whole
// document image instead and is not clipped here.
const MAX_INPUT_CHARS = 120_000;
// Anthropic PDF request limit (same bound as the OCR path).
const PDF_MAX_BYTES = 32 * 1024 * 1024;

const EXTRACTION_TOOL: ChatTool = {
  name: 'record_extraction',
  description: 'Записати структуровані поля, розпізнані в документі постачання.',
  input_schema: {
    type: 'object',
    properties: {
      doc_type: {
        type: 'string',
        enum: DOC_TYPES as unknown as string[],
        description: 'Основний тип документа. Обери найточніший; якщо не зрозуміло — "other".',
      },
      also_contains: {
        type: 'array',
        description:
          'Якщо ОДИН файл містить кілька документів (напр. інвойс і пакувальний ' +
          'лист разом — 2-в-1), перелічи тут додаткові типи, окрім основного doc_type. ' +
          'Інакше — порожній масив.',
        items: { type: 'string', enum: DOC_TYPES as unknown as string[] },
      },
      po_number: { type: 'string', description: 'Номер замовлення (PO), якщо є.' },
      invoice_number: { type: 'string', description: 'Номер інвойсу, якщо є.' },
      contract_number: {
        type: 'string',
        description: 'Номер контракту/договору ЗЕД або доповнення, якщо є.',
      },
      total_value: { type: 'number', description: 'Загальна сума.' },
      currency: { type: 'string', description: 'Валюта (ISO, напр. USD, EUR).' },
      hs_code: { type: 'string', description: 'Код УКТ ЗЕД / HS, якщо вказано.' },
      country_of_origin: { type: 'string', description: 'Країна походження.' },
      buyer: { type: 'string', description: 'Покупець.' },
      seller: { type: 'string', description: 'Продавець/постачальник.' },
      manufacturer: {
        type: 'string',
        description: 'Виробник товару (назва компанії), якщо вказано. Для ліків — виробник субстанції/препарату.',
      },
      registration_number: {
        type: 'string',
        description:
          'Реєстраційний номер, якщо є (напр. українське реєстраційне посвідчення ' +
          'ліків формату UA/19603/01/01, номер сертифіката тощо).',
      },
      incoterm: { type: 'string', description: 'Умови поставки (Incoterms).' },
      document_date: { type: 'string', description: 'Дата документа (формат YYYY-MM-DD).' },
      expiry_date: {
        type: 'string',
        description: 'Дата закінчення дії (сертифіката/ліцензії), формат YYYY-MM-DD.',
      },
      shipment_date: {
        type: 'string',
        description: 'Дата відвантаження/відправлення, формат YYYY-MM-DD.',
      },
      delivery_deadline: {
        type: 'string',
        description: 'Крайній термін поставки/доставки, формат YYYY-MM-DD.',
      },
      total_weight_kg: { type: 'number', description: 'Загальна вага, кг (якщо тільки одна вказана).' },
      net_weight_kg: { type: 'number', description: 'Вага нетто, кг.' },
      gross_weight_kg: { type: 'number', description: 'Вага брутто, кг.' },
      packages_count: { type: 'number', description: 'Кількість місць/пакувань.' },
      line_items: {
        type: 'array',
        description:
          'Товарні позиції з таблиці інвойсу/пакувального листа. Кожен рядок — ' +
          'окрема позиція. Витягуй ДОСЛІВНО з таблиці; якщо таблиці немає — порожній масив.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Найменування товару/позиції.' },
            quantity: { type: 'number', description: 'Кількість.' },
            unit: { type: 'string', description: 'Одиниця виміру (kg, pcs, шт тощо).' },
            unit_price: { type: 'string', description: 'Ціна за одиницю.' },
            amount: { type: 'string', description: 'Сума по позиції.' },
            hs_code: { type: 'string', description: 'Код УКТ ЗЕД по позиції, якщо є.' },
            batch_no: { type: 'string', description: 'Номер партії/лоту, якщо є.' },
          },
          required: ['description'],
        },
      },
      parties: {
        type: 'array',
        description:
          'Усі окремі компанії/сторони, названі в документі, з їхньою роллю ' +
          '(продавець/покупець/посередник/вантажоодержувач/агент тощо) та країною/адресою, якщо вказані.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Назва компанії/сторони.' },
            role: { type: 'string', description: 'Роль у договорі, як зазначено в документі.' },
            country: { type: 'string', description: 'Країна сторони.' },
            address: { type: 'string', description: 'Адреса сторони, якщо вказана.' },
          },
          required: ['name'],
        },
      },
      field_confidence: {
        type: 'object',
        description:
          'Наскільки впевнено кожне ключове поле прочитано з документа: ' +
          '"high" — чітко видно; "medium" — читається, але є сумнів; ' +
          '"low" — розмито/нерозбірливо/довелося здогадуватись. ' +
          'Вказуй лише для полів, які ти реально заповнив.',
        properties: Object.fromEntries(
          CONFIDENCE_FIELDS.map((f) => [
            f,
            { type: 'string', enum: CONFIDENCE_LEVELS as unknown as string[] },
          ]),
        ),
      },
      extraction_note: {
        type: 'string',
        description:
          'Короткий примітка, якщо документ погано читається (скан, розмито, ' +
          'обрізано) або є неоднозначності. Інакше пропусти.',
      },
    },
    required: ['doc_type'],
  },
};

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function toConfidence(v: unknown): Confidence | null {
  const s = toStr(v)?.toLowerCase();
  return s && (CONFIDENCE_LEVELS as readonly string[]).includes(s) ? (s as Confidence) : null;
}

function normalizeFieldConfidence(v: unknown): FieldConfidence {
  if (!v || typeof v !== 'object') return {};
  const rec = v as Record<string, unknown>;
  const out: FieldConfidence = {};
  for (const f of CONFIDENCE_FIELDS) {
    const c = toConfidence(rec[f]);
    if (c) out[f] = c;
  }
  return out;
}

function normalizeDocTypes(v: unknown, exclude: DocType): DocType[] {
  if (!Array.isArray(v)) return [];
  const out: DocType[] = [];
  for (const item of v) {
    const s = toStr(item);
    if (s && (DOC_TYPES as readonly string[]).includes(s) && s !== exclude && !out.includes(s as DocType)) {
      out.push(s as DocType);
    }
  }
  return out;
}

function normalizeLineItems(v: unknown): ExtractedLineItem[] {
  if (!Array.isArray(v)) return [];
  const out: ExtractedLineItem[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const description = toStr(rec.description);
    const quantity = toNum(rec.quantity);
    const amount = toNum(rec.amount);
    // Drop rows that carry no identifying information at all.
    if (!description && quantity === null && amount === null) continue;
    out.push({
      description,
      quantity,
      unit: toStr(rec.unit),
      unit_price: toNum(rec.unit_price),
      amount,
      hs_code: toStr(rec.hs_code),
      batch_no: toStr(rec.batch_no),
    });
  }
  return out;
}

function normalize(input: Record<string, unknown>): ExtractedFields {
  const rawType = toStr(input.doc_type);
  const doc_type = (DOC_TYPES as readonly string[]).includes(rawType ?? '')
    ? (rawType as DocType)
    : 'other';
  return {
    doc_type,
    also_contains: normalizeDocTypes(input.also_contains, doc_type),
    po_number: toStr(input.po_number),
    invoice_number: toStr(input.invoice_number),
    contract_number: toStr(input.contract_number),
    total_value: toNum(input.total_value),
    currency: toStr(input.currency),
    hs_code: toStr(input.hs_code),
    country_of_origin: toStr(input.country_of_origin),
    buyer: toStr(input.buyer),
    seller: toStr(input.seller),
    incoterm: toStr(input.incoterm),
    manufacturer: toStr(input.manufacturer),
    registration_number: toStr(input.registration_number),
    document_date: toStr(input.document_date),
    expiry_date: toStr(input.expiry_date),
    shipment_date: toStr(input.shipment_date),
    delivery_deadline: toStr(input.delivery_deadline),
    parties: normalizeParties(input.parties),
    total_weight_kg: toNum(input.total_weight_kg),
    net_weight_kg: toNum(input.net_weight_kg),
    gross_weight_kg: toNum(input.gross_weight_kg),
    packages_count: toNum(input.packages_count),
    line_items: normalizeLineItems(input.line_items),
    field_confidence: normalizeFieldConfidence(input.field_confidence),
    extraction_note: toStr(input.extraction_note),
  };
}

function normalizeParties(v: unknown): ExtractedParty[] {
  if (!Array.isArray(v)) return [];
  const out: ExtractedParty[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = toStr(rec.name);
    if (!name) continue; // drop entries with no identifiable name
    out.push({
      name,
      role: toStr(rec.role),
      country: toStr(rec.country),
      address: toStr(rec.address),
    });
  }
  return out;
}

const INSTRUCTION =
  'Витягни структуровані поля з цього документа постачання та виклич ' +
  'record_extraction. Читай цифри, суми, ваги та таблиці ДОСЛІВНО з документа. ' +
  'Якщо це інвойс або пакувальний лист із таблицею товарів — заповни line_items ' +
  'по рядках. Витягуй виробника (manufacturer) та реєстраційний номер ' +
  '(registration_number, напр. UA/19603/01/01) ДОСЛІВНО, якщо вони є. ' +
  'Не вигадуй значень: якщо поля немає в документі — пропусти його. ' +
  'Для кожного заповненого ключового поля познач field_confidence; якщо документ ' +
  'погано читається — додай extraction_note.';

function imageMediaType(name: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const n = name.toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

/** Runs the forced-tool extraction over the given content blocks. */
async function runExtraction(content: ChatContentBlockParam[]): Promise<ExtractedFields | null> {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: 'tool', name: 'record_extraction' },
    messages: [{ role: 'user', content }],
  });
  const block = msg.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') return null;
  return normalize(block.input as Record<string, unknown>);
}

/**
 * Extracts structured fields from a document's plain text. Returns null if the
 * model did not produce a tool call (caller treats that as "no extraction").
 * Used for docx/xlsx/csv/md and as a fallback for the vision path.
 */
export async function extractDocumentFields(text: string): Promise<ExtractedFields | null> {
  const clipped = text.slice(0, MAX_INPUT_CHARS);
  return runExtraction([{ type: 'text', text: `${INSTRUCTION}\n\n${clipped}` }]);
}

/**
 * Vision extraction: feeds the ORIGINAL PDF/image to Claude so figures/tables are
 * read from the document image directly. Returns null for unsupported types or an
 * over-large PDF (caller then falls back to the text path). Key stays server-side.
 */
export async function extractDocumentFieldsFromDocument(
  buf: Buffer,
  type: FileType,
  name: string,
): Promise<ExtractedFields | null> {
  let media: ChatContentBlockParam;
  if (type === 'pdf') {
    if (buf.length > PDF_MAX_BYTES) return null;
    media = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
    };
  } else if (type === 'image') {
    media = {
      type: 'image',
      source: { type: 'base64', media_type: imageMediaType(name), data: buf.toString('base64') },
    };
  } else {
    return null;
  }
  return runExtraction([media, { type: 'text', text: INSTRUCTION }]);
}
