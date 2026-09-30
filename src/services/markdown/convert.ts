import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { config } from '../../config.js';
import type { FileType } from '../../domain/folders.js';
import { extractText } from '../extract/index.js';
import { htmlToMarkdown, rowsToMarkdownTable, type MarkdownPage } from './format.js';
import { imageToMarkdown, pdfToMarkdown } from './vision.js';

const run = promisify(execFile);

export interface ConversionResult {
  pages: MarkdownPage[];
  /** How the Markdown was produced — surfaced to the agent/logs. */
  converter: 'vision' | 'text' | 'vision+text' | 'mammoth' | 'libreoffice+mammoth' | 'sheet' | 'md' | 'none';
  /** Some content may be missing (output cap hit or pages not transcribed). */
  partial: boolean;
  pageCount: number | null;
  note: string | null;
}

/** OLE2 compound-file magic (legacy .doc/.xls). */
function isOle(buf: Buffer): boolean {
  return buf.length > 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1;
}

/** Legacy binary .doc → .docx via headless LibreOffice. Returns null if unavailable. */
async function docToDocx(buf: Buffer): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'doc2docx-'));
  try {
    const src = join(dir, 'in.doc');
    await writeFile(src, buf);
    await run(config.LIBREOFFICE_BIN, ['--headless', '--convert-to', 'docx', '--outdir', dir, src], {
      timeout: 120_000,
    });
    return await readFile(join(dir, 'in.docx'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`LibreOffice .doc conversion failed: ${(err as Error).message}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function docxToMarkdown(buf: Buffer): Promise<ConversionResult> {
  let data = buf;
  let converter: ConversionResult['converter'] = 'mammoth';
  if (isOle(buf)) {
    const converted = await docToDocx(buf);
    if (!converted) {
      return {
        pages: [],
        converter: 'none',
        partial: false,
        pageCount: null,
        note: 'Старий формат .doc не вдалося сконвертувати. Збережіть файл як .docx або PDF.',
      };
    }
    data = converted;
    converter = 'libreoffice+mammoth';
  }
  try {
    const { value } = await mammoth.convertToHtml({ buffer: data });
    const md = htmlToMarkdown(value);
    return { pages: md ? [{ page: null, markdown: md }] : [], converter, partial: false, pageCount: null, note: null };
  } catch {
    return { pages: [], converter: 'none', partial: false, pageCount: null, note: 'Документ Word не читається.' };
  }
}

function sheetToMarkdown(buf: Buffer): ConversionResult {
  try {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const pages: MarkdownPage[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      // raw:false → formatted cell text (dates/numbers as shown in Excel).
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, blankrows: false });
      const table = rowsToMarkdownTable(rows);
      if (table) pages.push({ page: null, markdown: `## Аркуш: ${name}\n\n${table}` });
    }
    return { pages, converter: 'sheet', partial: false, pageCount: null, note: null };
  } catch {
    return { pages: [], converter: 'none', partial: false, pageCount: null, note: 'Таблицю не вдалося прочитати.' };
  }
}

const textLen = (ps: { text: string }[]): number => ps.reduce((n, p) => n + p.text.length, 0);

async function pdfToMd(buf: Buffer): Promise<ConversionResult> {
  const textPages = await extractText(buf, 'pdf').catch(() => []);
  const asMd = (ps: typeof textPages): MarkdownPage[] => ps.map((p) => ({ page: p.page, markdown: p.text }));

  // Cheap mode: keep a dense text layer as-is; vision only for sparse/scanned PDFs.
  const sparse = textPages.length === 0 || textLen(textPages) < Math.max(120, textPages.length * 60);
  if (!config.OCR_ENABLED || (!config.MARKDOWN_VISION_ENABLED && !sparse)) {
    return { pages: asMd(textPages), converter: 'text', partial: false, pageCount: null, note: null };
  }

  try {
    const v = await pdfToMarkdown(buf);
    const pages = [...v.pages];
    let converter: ConversionResult['converter'] = 'vision';
    // Pages vision could not transcribe → fill from the text layer (never lose a page).
    if (v.failedPages.length) {
      const fill = textPages.filter((p) => p.page !== null && v.failedPages.includes(p.page));
      if (fill.length) {
        pages.push(...asMd(fill));
        pages.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
        converter = 'vision+text';
      }
    }
    const missing = v.failedPages.filter((n) => !pages.some((p) => p.page === n));
    const notes: string[] = [];
    if (v.partial) notes.push('частину сторінок розпізнано не повністю (ліміт відповіді)');
    if (missing.length) notes.push(`не вдалося розпізнати стор. ${missing.join(', ')}`);
    // Vision returned less than the text layer (e.g. API outage) → prefer the text layer.
    const visionLen = pages.reduce((n, p) => n + p.markdown.length, 0);
    if (visionLen < textLen(textPages) * 0.5) {
      return { pages: asMd(textPages), converter: 'text', partial: false, pageCount: v.pageCount || null, note: null };
    }
    return {
      pages,
      converter,
      partial: v.partial || missing.length > 0,
      pageCount: v.pageCount || null,
      note: notes.length ? notes.join('; ') : null,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Vision PDF conversion failed, using text layer: ${(err as Error).message}`);
    return { pages: asMd(textPages), converter: 'text', partial: false, pageCount: null, note: null };
  }
}

/**
 * Converts a stored document to Markdown pages. Claude vision reads PDFs and
 * images; Office/CSV files are converted locally (they already carry structure).
 */
export async function convertToMarkdown(buf: Buffer, type: FileType, name: string): Promise<ConversionResult> {
  const conv = await convertRaw(buf, type, name);
  return { ...conv, pages: conv.pages.map((p) => ({ ...p, markdown: stripControlChars(p.markdown) })) };
}

/**
 * Removes NUL and other C0 control characters (keeps \t \n \r). PDF text layers
 * can contain U+0000, which Postgres rejects in TEXT/JSONB — the save failed and
 * the file was retried (with a full vision re-run) over and over.
 */
export function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

async function convertRaw(buf: Buffer, type: FileType, name: string): Promise<ConversionResult> {
  switch (type) {
    case 'pdf':
      return pdfToMd(buf);
    case 'image': {
      if (!config.OCR_ENABLED) return { pages: [], converter: 'none', partial: false, pageCount: 1, note: null };
      const v = await imageToMarkdown(buf, name);
      return {
        pages: v.pages,
        converter: 'vision',
        partial: v.partial,
        pageCount: 1,
        note: v.partial ? 'розпізнано не повністю (ліміт відповіді)' : null,
      };
    }
    case 'docx':
      return docxToMarkdown(buf);
    case 'xlsx':
    case 'csv':
      return sheetToMarkdown(buf);
    case 'md': {
      const md = buf.toString('utf8').trim();
      return { pages: md ? [{ page: null, markdown: md }] : [], converter: 'md', partial: false, pageCount: null, note: null };
    }
    default:
      return { pages: [], converter: 'none', partial: false, pageCount: null, note: null };
  }
}
