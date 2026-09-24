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

  const out: ZipEntry[] = [];
  for (const f of fileEntries) {
    const p = f.path.replace(/\\/g, '/');
    const segments = p.split('/').filter(Boolean);
    const base = segments[segments.length - 1] ?? '';
    // Skip junk: macOS resource forks, hidden/dotfiles, empty names.
    if (!base || base.startsWith('.') || p.startsWith('__MACOSX/')) continue;
    const folderName = segments.length > 1 ? segments[segments.length - 2]! : null;
    const buffer = await f.buffer();
    out.push({ path: p, name: base, folderName, buffer });
  }
  return out;
}
