import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
// Import the lib entry (not the package root) to avoid pdf-parse's import-time
// debug block that reads a bundled test PDF and crashes in production.
import pdf from 'pdf-parse/lib/pdf-parse.js';
import type { FileType } from '../../domain/folders.js';

export interface ExtractedPage {
  /** 1-indexed page number for PDFs; null for formats without pages. */
  page: number | null;
  text: string;
}

/**
 * Extracts plain text from a stored document, preserving per-page boundaries
 * where the format supports it (so search results and read_file can cite a
 * page). Images are out of scope for v1 (OCR is a documented v2 addition).
 */
export async function extractText(data: Buffer, type: FileType): Promise<ExtractedPage[]> {
  switch (type) {
    case 'pdf':
      return extractPdf(data);
    case 'docx':
      return extractDocx(data);
    case 'xlsx':
    case 'csv':
      return extractSpreadsheet(data);
    case 'md':
      return [{ page: null, text: data.toString('utf8') }];
    case 'image':
      // OCR out of scope for v1.
      return [];
    default:
      return [];
  }
}

async function extractPdf(data: Buffer): Promise<ExtractedPage[]> {
  const pages: ExtractedPage[] = [];
  let pageNo = 0;
  await pdf(data, {
    // Called once per page, in order.
    pagerender: async (pageData: {
      getTextContent: (opts: unknown) => Promise<{ items: { str: string; transform: number[] }[] }>;
    }) => {
      pageNo += 1;
      const content = await pageData.getTextContent({ normalizeWhitespace: true });
      let lastY: number | null = null;
      let text = '';
      for (const item of content.items) {
        const y = item.transform[5];
        if (lastY === null || lastY === y) text += item.str;
        else text += `\n${item.str}`;
        lastY = y ?? lastY;
      }
      pages.push({ page: pageNo, text: text.trim() });
      return text;
    },
  });
  return pages.filter((p) => p.text.length > 0);
}

async function extractDocx(data: Buffer): Promise<ExtractedPage[]> {
  const { value } = await mammoth.extractRawText({ buffer: data });
  const text = value.trim();
  return text ? [{ page: null, text }] : [];
}

function extractSpreadsheet(data: Buffer): ExtractedPage[] {
  const wb = XLSX.read(data, { type: 'buffer' });
  const pages: ExtractedPage[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet).trim();
    if (csv) pages.push({ page: null, text: `# ${sheetName}\n${csv}` });
  }
  return pages;
}
