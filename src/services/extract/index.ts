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
      getTextContent: (opts: unknown) => Promise<{
        items: { str: string; transform: number[]; width?: number; hasEOL?: boolean }[];
      }>;
    }) => {
      pageNo += 1;
      const content = await pageData.getTextContent({ normalizeWhitespace: true });
      // Reconstruct spacing from geometry. The old code concatenated same-line
      // items with NO separator — gluing words ("Invoice No:123") and collapsing
      // multi-column customs tables, which was the main extraction/hallucination
      // source. Here we insert a word/column break based on the horizontal GAP
      // between an item's start x and the previous item's end x. Gap-based (not
      // per-item) so it works whether pdf.js emits words or single glyphs — it
      // never splits a contiguous word.
      let lastX: number | null = null;
      let lastY: number | null = null;
      let text = '';
      for (const item of content.items) {
        if (item.hasEOL && item.str === '') {
          text += '\n';
          lastX = null;
          continue;
        }
        const x = item.transform[4] ?? 0;
        const y = item.transform[5] ?? 0;
        const fontSize = Math.abs(item.transform[0] ?? 4) || 4;
        if (lastY !== null && Math.abs(y - lastY) > 1) {
          text += '\n'; // new visual line
        } else if (lastX !== null) {
          const gap = x - lastX;
          const spaceW = fontSize * 0.2;
          if (gap > spaceW * 4)
            text += '    '; // wide gap → column break
          else if (gap > spaceW) text += ' '; // ordinary word break
          // else: glyphs of the same word are contiguous → no separator
        }
        text += item.str;
        const w = typeof item.width === 'number' ? item.width : item.str.length * fontSize * 0.5;
        lastX = x + w;
        lastY = y ?? lastY;
      }
      pages.push({ page: pageNo, text: text.trim() });
      return text;
    },
  });
  return pages.filter((p) => p.text.length > 0);
}

async function extractDocx(data: Buffer): Promise<ExtractedPage[]> {
  try {
    const { value } = await mammoth.extractRawText({ buffer: data });
    const text = value.trim();
    return text ? [{ page: null, text }] : [];
  } catch {
    // mammoth only reads OOXML .docx. A legacy binary .doc throws here — treat it
    // as "no text" so it lands on the manual-entry flag instead of failing the
    // whole indexing job (and burning its retries).
    return [];
  }
}

function extractSpreadsheet(data: Buffer): ExtractedPage[] {
  try {
    // xlsx auto-detects the workbook format, so this covers both .xlsx and the
    // legacy binary .xls.
    const wb = XLSX.read(data, { type: 'buffer' });
    const pages: ExtractedPage[] = [];
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet).trim();
      if (csv) pages.push({ page: null, text: `# ${sheetName}\n${csv}` });
    }
    return pages;
  } catch {
    return [];
  }
}
