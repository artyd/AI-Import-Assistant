import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import mammoth from 'mammoth';
import { config } from '../lib/config.js';
import { query } from '../db/pool.js';
import type { DocData, DocKind } from './schema.js';
import { tagsFor } from './templateData.js';
import { applyStamps, loadStampImages, positionPreviewStamps, stampTags } from './stamps.js';

/**
 * Fills the team's own Word templates (made from real contracts / invoices, so
 * the output looks exactly like what the logists send today). Bundled templates
 * live next to this module (copied into dist/ by scripts/copy-assets.mjs); a
 * document may point at a custom one uploaded by the team (doc_templates).
 */
const run = promisify(execFile);

export const TEMPLATE_FILE: Record<DocKind, string> = {
  contract: 'contract-spec.docx',
  appendix: 'appendix.docx',
  invoice: 'invoice-packing.docx',
  ua_invoice: 'ua-invoice.docx',
};

const cache = new Map<DocKind, Buffer>();

export async function bundledTemplate(kind: DocKind): Promise<Buffer> {
  const hit = cache.get(kind);
  if (hit) return hit;
  const buf = await readFile(new URL(`./templates/${TEMPLATE_FILE[kind]}`, import.meta.url));
  cache.set(kind, buf);
  return buf;
}

async function customTemplate(id: string, kind: DocKind): Promise<Buffer | null> {
  const { rows } = await query<{ file: Buffer }>('SELECT file FROM doc_templates WHERE id = $1 AND kind = $2', [id, kind]);
  return rows[0]?.file ?? null;
}

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(message);
  }
}

/** docxtemplater's error list → human lines («Незакритий тег {#items}…»). */
function explain(err: unknown): string[] {
  const e = err as { properties?: { errors?: { properties?: { explanation?: string; xtag?: string } }[]; explanation?: string } };
  const list = e.properties?.errors?.map((x) => x.properties?.explanation ?? '') ?? [e.properties?.explanation ?? String(err)];
  return list.filter(Boolean).slice(0, 10);
}

/** Fills a template buffer. Throws TemplateError with readable reasons on a broken template. */
export function fillTemplate(tpl: Buffer, tags: Record<string, unknown>): Buffer {
  try {
    const doc = new Docxtemplater(new PizZip(tpl), { paragraphLoop: true, linebreaks: true, errorLogging: false, nullGetter: () => '' });
    doc.render(tags);
    return doc.toBuffer({ compression: 'DEFLATE' });
  } catch (err) {
    throw new TemplateError('Шаблон не заповнюється', explain(err));
  }
}

export async function renderDocx(kind: DocKind, data: DocData): Promise<Buffer> {
  const tid = (data as { templateId?: string | null }).templateId;
  const tpl = (tid ? await customTemplate(tid, kind) : null) ?? (await bundledTemplate(kind));
  const stamps = data.stamps ?? [];
  const filled = fillTemplate(tpl, { ...tagsFor(kind, data), ...stampTags(kind, stamps) });
  return stamps.length ? applyStamps(filled, stamps, await loadStampImages(stamps)) : filled;
}

/** The body of the filled document as HTML, for the live preview (no header/footer). */
export async function renderPreviewHtml(kind: DocKind, data: DocData): Promise<string> {
  const { value } = await mammoth.convertToHtml(
    { buffer: await renderDocx(kind, data) },
    {
      convertImage: mammoth.images.imgElement(async (image) => ({
        src: `data:${image.contentType};base64,${await image.read('base64')}`,
        alt: (image as { altText?: string }).altText ?? '',
      })),
    },
  );
  return positionPreviewStamps(value);
}

/** .docx → .pdf with headless LibreOffice (the same binary that converts legacy .doc at ingest). */
export async function docxToPdf(docx: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'docb-pdf-'));
  try {
    const src = join(dir, 'doc.docx');
    await writeFile(src, docx);
    // A private profile dir keeps parallel conversions from fighting over one user profile.
    await run(
      config.LIBREOFFICE_BIN,
      [`-env:UserInstallation=file://${dir.replace(/\\/g, '/')}/profile`, '--headless', '--convert-to', 'pdf', '--outdir', dir, src],
      { timeout: 120_000 },
    );
    return await readFile(join(dir, 'doc.pdf'));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const KIND_NAME: Record<DocKind, { uk: string; en: string }> = {
  contract: { uk: 'Контракт', en: 'Contract' },
  appendix: { uk: 'Додаток', en: 'Annex' },
  invoice: { uk: 'Інвойс', en: 'Invoice' },
  ua_invoice: { uk: 'Накладна', en: 'Nakladna' },
};

/** «Контракт 31072026-PNS.docx» — an ASCII-safe fallback plus the UTF-8 name. */
export function downloadName(kind: DocKind, number: string, ext: 'docx' | 'pdf' = 'docx', label?: string): { ascii: string; utf8: string } {
  const safe = number.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'draft';
  const n = KIND_NAME[kind];
  const utf8 = `${label ?? n.uk} ${safe}.${ext}`;
  const ascii = `${n.en}_${safe.replace(/[^\x20-\x7e]/g, '_')}.${ext}`;
  return { ascii, utf8 };
}
