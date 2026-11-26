import { readFile } from 'node:fs/promises';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import mammoth from 'mammoth';
import type { ContractData, DocKind, InvoiceData } from './schema.js';
import { contractTags, invoiceTags } from './templateData.js';

/**
 * Fills the team's own Word templates (made from real contracts / invoices, so
 * the output looks exactly like what the logists send today). Templates live
 * next to this module and are copied into dist/ by scripts/copy-assets.mjs.
 */
const TEMPLATE_FILE: Record<DocKind, string> = {
  contract: 'contract-spec.docx',
  invoice: 'invoice-packing.docx',
};

const cache = new Map<DocKind, Buffer>();

async function template(kind: DocKind): Promise<Buffer> {
  const hit = cache.get(kind);
  if (hit) return hit;
  const buf = await readFile(new URL(`./templates/${TEMPLATE_FILE[kind]}`, import.meta.url));
  cache.set(kind, buf);
  return buf;
}

export function tagsFor(kind: DocKind, data: ContractData | InvoiceData): Record<string, unknown> {
  return kind === 'contract' ? contractTags(data as ContractData) : invoiceTags(data as InvoiceData);
}

export async function renderDocx(kind: DocKind, data: ContractData | InvoiceData): Promise<Buffer> {
  const zip = new PizZip(await template(kind));
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    errorLogging: false,
    nullGetter: () => '',
  });
  doc.render(tagsFor(kind, data));
  return doc.toBuffer({ compression: 'DEFLATE' });
}

/** The body of the filled document as HTML, for the live preview (no header/footer). */
export async function renderPreviewHtml(kind: DocKind, data: ContractData | InvoiceData): Promise<string> {
  const buffer = await renderDocx(kind, data);
  const { value } = await mammoth.convertToHtml({ buffer });
  return value;
}

/** «Контракт 31072026-PNS.docx» — an ASCII-safe fallback plus the UTF-8 name. */
export function downloadName(kind: DocKind, number: string): { ascii: string; utf8: string } {
  const safe = number.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'draft';
  const utf8 = `${kind === 'contract' ? 'Контракт' : 'Інвойс'} ${safe}.docx`;
  const ascii = `${kind === 'contract' ? 'Contract' : 'Invoice'}_${safe.replace(/[^\x20-\x7e]/g, '_')}.docx`;
  return { ascii, utf8 };
}
