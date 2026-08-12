import { anthropic, MODEL, type ChatTool } from '../../anthropic/client.js';

/**
 * Structured field extraction for a single document. Runs a non-streaming Claude
 * call with a FORCED tool so the model must return JSON matching our schema
 * (never free text). The result is stored in `document_extractions.extracted_fields`
 * and is the deterministic source for checklist + discrepancy computation — those
 * never re-read raw document text at answer time.
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
}

const MAX_INPUT_CHARS = 30_000;

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
  };
}

/**
 * Extracts structured fields from a document's plain text. Returns null if the
 * model did not produce a tool call (caller treats that as "no extraction").
 */
export async function extractDocumentFields(text: string): Promise<ExtractedFields | null> {
  const clipped = text.slice(0, MAX_INPUT_CHARS);
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: 'tool', name: 'record_extraction' },
    messages: [
      {
        role: 'user',
        content:
          'Витягни структуровані поля з наступного документа постачання та виклич ' +
          'record_extraction. Не вигадуй значень: якщо поля немає в тексті — пропусти його.\n\n' +
          clipped,
      },
    ],
  });

  const block = msg.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') return null;
  return normalize(block.input as Record<string, unknown>);
}
