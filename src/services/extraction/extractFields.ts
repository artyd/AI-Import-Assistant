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

export interface ExtractedParty {
  name: string;
  role: string | null;
  country: string | null;
  address: string | null;
}

export interface ExtractedFields {
  doc_type: DocType;
  po_number: string | null;
  invoice_number: string | null;
  total_weight_kg: number | null;
  packages_count: number | null;
  total_value: number | null;
  currency: string | null;
  hs_code: string | null;
  country_of_origin: string | null;
  buyer: string | null;
  seller: string | null;
  incoterm: string | null;
  // Dates (ISO yyyy-mm-dd where possible) — power the proactive risk engine
  // (expiry / deadline checks). Null when the document does not state them.
  document_date: string | null;
  expiry_date: string | null;
  shipment_date: string | null;
  delivery_deadline: string | null;
  parties: ExtractedParty[];
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
        description: 'Тип документа. Обери найточніший; якщо не зрозуміло — "other".',
      },
      po_number: { type: 'string', description: 'Номер замовлення (PO), якщо є.' },
      invoice_number: { type: 'string', description: 'Номер інвойсу, якщо є.' },
      total_weight_kg: { type: 'number', description: 'Загальна вага, кг.' },
      packages_count: { type: 'number', description: 'Кількість місць/пакувань.' },
      total_value: { type: 'number', description: 'Загальна сума.' },
      currency: { type: 'string', description: 'Валюта (ISO, напр. USD, EUR).' },
      hs_code: { type: 'string', description: 'Код УКТ ЗЕД / HS, якщо вказано.' },
      country_of_origin: { type: 'string', description: 'Країна походження.' },
      buyer: { type: 'string', description: 'Покупець.' },
      seller: { type: 'string', description: 'Продавець/постачальник.' },
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

function normalize(input: Record<string, unknown>): ExtractedFields {
  const rawType = toStr(input.doc_type);
  const doc_type = (DOC_TYPES as readonly string[]).includes(rawType ?? '')
    ? (rawType as DocType)
    : 'other';
  return {
    doc_type,
    po_number: toStr(input.po_number),
    invoice_number: toStr(input.invoice_number),
    total_weight_kg: toNum(input.total_weight_kg),
    packages_count: toNum(input.packages_count),
    total_value: toNum(input.total_value),
    currency: toStr(input.currency),
    hs_code: toStr(input.hs_code),
    country_of_origin: toStr(input.country_of_origin),
    buyer: toStr(input.buyer),
    seller: toStr(input.seller),
    incoterm: toStr(input.incoterm),
    document_date: toStr(input.document_date),
    expiry_date: toStr(input.expiry_date),
    shipment_date: toStr(input.shipment_date),
    delivery_deadline: toStr(input.delivery_deadline),
    parties: normalizeParties(input.parties),
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
  'Не вигадуй значень: якщо поля немає в документі — пропусти його.';

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
    max_tokens: 2048,
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
