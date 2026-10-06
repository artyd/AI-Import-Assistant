import { PDFDocument, PDFName } from 'pdf-lib';

/**
 * Version / provenance hints for a shipment file, so the agent can tell a draft
 * or "COPY" from the final document, a translation from the original, and spot a
 * file edited after it was issued. Live test «Сборник 18» showed the agent
 * treating an HBL «COPY» as authoritative and missing a locally re-saved HBL
 * (FREIGHT COLLECT → PREPAID) — it had no signal that versions differ.
 *
 * Everything here is a HINT from the file name, the first page of its Markdown
 * and PDF metadata — never a verdict. The agent reads the documents to confirm.
 */

interface Marker {
  label: string;
  /** Matched against the lower-cased file name. */
  name?: RegExp;
  /** Matched against the first ~3000 chars of the document's Markdown. */
  text?: RegExp;
}

const MARKERS: Marker[] = [
  { label: 'чернетка/draft', name: /draft|чернетк|черновик|драфт|проект/i, text: /\bdraft\b/i },
  { label: 'копія (COPY)', text: /(?<!NEGOTIABLE\s)\bCOPY\b/ }, // not the boilerplate «NON-NEGOTIABLE COPY»
  { label: 'telex release (фінальний коносамент)', name: /telex|tlx/i, text: /\b(TLX|TELEX)\s*RELEASE/i },
  { label: 'виправлена версія (revised)', name: /revised|исправл|виправл/i },
  { label: 'фінальна/оригінал', name: /final|финал|фінал|original|оригинал|оригінал|(?<![a-z])signed|подписан|підписан/i, text: /\bORIGINAL\b/ },
  { label: 'переклад (не оригінал)', name: /переклад|перевод|translation|\bukr\b|_ua\b/i },
  { label: 'шаблон/бланк', name: /template|шаблон|模板|бланк/i },
  { label: 'видано заднім числом (ISSUED RETROSPECTIVELY)', text: /ISSUED\s+RETROSPECTIVELY/i },
  { label: 'CHED у статусі NOWY (чернетка, без рішення)', name: /\bnowy\b/i, text: /\bNOWY\b/ },
];

/** Hints from the file name and the start of its Markdown. */
export function versionHints(name: string, markdownHead = ''): string[] {
  const n = name.toLowerCase();
  const head = markdownHead.slice(0, 3000);
  const out: string[] = [];
  for (const m of MARKERS) {
    if ((m.name && m.name.test(n)) || (m.text && head && m.text.test(head))) out.push(m.label);
  }
  // "file (1).pdf", "file (2) (1).pdf" — a re-download / duplicate copy.
  if (/\(\d+\)/.test(name)) out.push('ймовірно повторне завантаження (у назві «(N)»)');
  return out;
}

/** "invoice (1).pdf" and "invoice.pdf" → the same key, to group same-named files. */
export function baseNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\s*\(\d+\)/g, '')
    .replace(/[_\-\s]+/g, ' ')
    .trim();
}

export interface PdfProvenance {
  created?: string;
  modified?: string;
  producer?: string;
  creator?: string;
  /** Set when the file was saved again well after it was created. */
  warning?: string;
}

/**
 * PDF Info-dictionary metadata. A modification date days after creation, or in a
 * different time zone (a Chinese issuer at +08 re-saved at +02), marks a file
 * that was edited after the issuer produced it.
 */
export async function pdfProvenance(buf: Buffer): Promise<PdfProvenance | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return null;
  }
  const created = safe(() => doc.getCreationDate());
  const modified = safe(() => doc.getModificationDate());
  const producer = safe(() => doc.getProducer())?.trim() || undefined;
  const creator = safe(() => doc.getCreator())?.trim() || undefined;
  const rawCreated = rawDate(doc, 'CreationDate');
  const rawModified = rawDate(doc, 'ModDate');
  const out: PdfProvenance = {
    created: created ? created.toISOString() : undefined,
    modified: modified ? modified.toISOString() : undefined,
    producer,
    creator,
  };
  if (created && modified) {
    const days = (modified.getTime() - created.getTime()) / 86_400_000;
    const tzC = tzOf(rawCreated);
    const tzM = tzOf(rawModified);
    if (days > 1) {
      out.warning = `файл змінено через ${Math.round(days)} дн. після створення — можлива пізніша правка`;
    } else if (tzC && tzM && tzC !== tzM && days > 0.01) {
      out.warning = `файл створено в часовому поясі ${tzC}, а змінено в ${tzM} — можлива правка іншою стороною`;
    }
  }
  if (!out.created && !out.modified && !out.producer && !out.creator) return null;
  return out;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Raw PDF date string (e.g. "D:20260119180628+08'00'") — keeps the time zone. */
function rawDate(doc: PDFDocument, key: 'CreationDate' | 'ModDate'): string | undefined {
  try {
    const info = (doc as unknown as { getInfoDict(): { lookup(k: PDFName): unknown } }).getInfoDict();
    const v = info.lookup(PDFName.of(key)) as { decodeText?: () => string; asString?: () => string } | undefined;
    return v?.decodeText?.() ?? v?.asString?.();
  } catch {
    return undefined;
  }
}

function tzOf(raw?: string): string | undefined {
  if (!raw) return undefined;
  const m = /([+\-Z])(\d{2})?'?(\d{2})?'?$/.exec(raw.trim());
  if (!m) return undefined;
  if (m[1] === 'Z') return '+00';
  return `${m[1]}${m[2] ?? '00'}`;
}

/** One line for read_file / find_files output. */
export function formatProvenance(p: PdfProvenance | null): string {
  if (!p) return '';
  const parts: string[] = [];
  if (p.created) parts.push(`створено ${p.created.slice(0, 16).replace('T', ' ')}`);
  if (p.modified) parts.push(`змінено ${p.modified.slice(0, 16).replace('T', ' ')}`);
  const tool = [p.creator, p.producer].filter(Boolean).join(' / ');
  if (tool) parts.push(`програма: ${tool}`);
  return `Метадані PDF: ${parts.join('; ')}${p.warning ? ` ⚠ ${p.warning}` : ''}`;
}
