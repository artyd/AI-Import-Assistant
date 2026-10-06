import unzipper from 'unzipper';
import { config } from '../config.js';

/** A single extractable file inside an uploaded archive. */
export interface ZipEntry {
  /** Full path inside the archive, e.g. "Invoices/2024/inv.pdf". */
  path: string;
  /** Base filename, e.g. "inv.pdf". */
  name: string;
  /** Immediate parent directory name (for the flat folder map), null at root. */
  folderName: string | null;
  buffer: Buffer;
}

/** Thrown when an archive breaches a zip-bomb guard; carries a machine reason. */
export class ZipGuardError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'ZipGuardError';
  }
}

export function isZipUpload(name: string): boolean {
  return name.toLowerCase().endsWith('.zip');
}

/**
 * Unpacks a zip buffer into file entries, in memory, with zip-bomb guards
 * (entry count + total uncompressed size). Directories, macOS resource forks
 * (`__MACOSX/`), and dotfiles are skipped. Throws ZipGuardError on a breach.
 * Folder structure is preserved shallowly: the flat folder model has no
 * nesting, so each entry maps to a folder named after its immediate parent dir.
 */
export async function unpackZip(buf: Buffer): Promise<ZipEntry[]> {
  const dir = await unzipper.Open.buffer(buf);
  const fileEntries = dir.files.filter((f) => f.type === 'File');

  if (fileEntries.length > config.MAX_ZIP_ENTRIES) {
    throw new ZipGuardError(`too_many_entries:${config.MAX_ZIP_ENTRIES}`);
  }
  const totalUncompressed = fileEntries.reduce((sum, f) => sum + (f.uncompressedSize ?? 0), 0);
  if (totalUncompressed > config.MAX_ZIP_UNCOMPRESSED_BYTES) {
    throw new ZipGuardError('uncompressed_too_large');
  }

  // The sizes above are what the archive CLAIMS — an attacker controls them and
  // unzipper's inflater doesn't enforce them. Count the bytes actually inflated
  // and abort past the per-entry and total caps (zip-bomb → OOM otherwise).
  let remaining = config.MAX_ZIP_UNCOMPRESSED_BYTES;
  const out: ZipEntry[] = [];
  for (const f of fileEntries) {
    const p = decodeEntryName(f).replace(/\\/g, '/');
    const segments = p.split('/').filter(Boolean);
    const base = segments[segments.length - 1] ?? '';
    // Skip junk: macOS resource forks, hidden/dotfiles, empty names.
    if (!base || base.startsWith('.') || p.startsWith('__MACOSX/')) continue;
    const folderName = segments.length > 1 ? segments[segments.length - 2]! : null;
    const buffer = await readCapped(f.stream(), Math.min(config.MAX_UPLOAD_BYTES, remaining));
    remaining -= buffer.length;
    out.push({ path: p, name: base, folderName, buffer });
  }
  return out;
}

interface EntryNameInfo {
  path: string;
  pathBuffer?: Buffer;
  isUnicode?: boolean | number;
}

const CJK = /[㐀-鿿]/g;
const CYRILLIC = /[Ѐ-ӿ]/g;
const BOX_DRAWING = /[─-◿]/; // cp866 0xB0–0xDF

/**
 * Entry names in zips made on non-UTF-8 Windows are stored in the OEM code page
 * without the UTF-8 flag, and unzipper decodes them as UTF-8 → «DL-��SPARTIC»
 * (live test «Сборник 18»: a Chinese supplier's archive, Cyrillic «А» stored in
 * GBK as A7 A1). Decode such names as GBK (Chinese Windows) or CP866
 * (Russian/Ukrainian Windows), choosing by which reading looks like text:
 * - valid UTF-8 → keep it;
 * - GBK decodes cleanly with no CJK (only Latin/Cyrillic) → GBK;
 * - CP866 reading contains box-drawing chars → the bytes are GBK lead bytes → GBK;
 * - otherwise CP866 (Cyrillic names from a Russian/Ukrainian archiver).
 */
export function decodeEntryName(e: EntryNameInfo): string {
  const buf = e.pathBuffer;
  if (!buf || e.isUnicode || buf.every((b) => b < 0x80)) return e.path;
  const utf8 = tryDecode('utf-8', buf);
  if (utf8 !== null) return utf8;
  const gbk = tryDecode('gbk', buf);
  const cp866 = tryDecode('ibm866', buf) ?? e.path;
  if (gbk === null) return cp866;
  const gbkCjk = (gbk.match(CJK) ?? []).length;
  if (gbkCjk === 0 && (gbk.match(CYRILLIC) ?? []).length > 0) return gbk;
  if (BOX_DRAWING.test(cp866)) return gbk;
  return gbkCjk > 0 && (cp866.match(CYRILLIC) ?? []).length === 0 ? gbk : cp866;
}

function tryDecode(encoding: string, buf: Buffer): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** Reads a stream into memory, aborting once more than `limit` bytes arrive. */
export async function readCapped(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += b.length;
    if (size > limit) {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      throw new ZipGuardError('uncompressed_too_large');
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
