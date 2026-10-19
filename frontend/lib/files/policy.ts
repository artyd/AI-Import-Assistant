// Upload policy — one place for what the app accepts and how big uploads are
// split. Mirrors the backend allow-list (src/lib/storage.ts) and limits
// (MAX_UPLOAD_BYTES / MAX_ZIP_BYTES / MAX_UPLOAD_FILES).

/** Everything the shipment upload accepts; a .zip is unpacked server-side. */
export const UPLOAD_ACCEPT = ".pdf,.docx,.doc,.xlsx,.xls,.csv,.png,.jpg,.jpeg,.zip";
/** A new version replaces ONE file — no archives. */
export const VERSION_ACCEPT = ".pdf,.docx,.doc,.xlsx,.xls,.csv,.png,.jpg,.jpeg";
/** Human list for error messages. */
export const ACCEPT_LABEL = "pdf, doc, docx, xls, xlsx, csv, png, jpg, zip";

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_BYTES = 200 * 1024 * 1024;
// Batching: well under the backend MAX_UPLOAD_FILES, and ~100 MB per request.
export const CLIENT_BATCH_FILES = 40;
export const CLIENT_BATCH_BYTES = 100 * 1024 * 1024;

const ACCEPT_EXT = UPLOAD_ACCEPT.split(",").map((s) => s.trim().toLowerCase());

export const isZip = (f: { name: string }) => f.name.toLowerCase().endsWith(".zip");
export const fmtMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

let pasteSeq = 0;

// MIME → extension for every supported type. Drag/paste sources (and pasted
// screenshots) often hand us a file whose NAME has no extension — the server's
// allow-list is extension-based, so we must derive one from the MIME type or the
// upload is rejected as "no_valid_files".
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
};

// If the file's name already ends in a supported extension, keep it as-is.
// Otherwise, if its MIME type is one we support, rebuild the file with a proper
// extension (preserving any original base name so the user still recognises it).
function normalizeDropped(file: File): File {
  const lower = file.name.toLowerCase();
  if (ACCEPT_EXT.some((ext) => lower.endsWith(ext))) return file;
  const ext = MIME_EXT[file.type.toLowerCase()];
  if (ext) {
    const rawBase = file.name.trim().replace(/[/\\]+/g, "_");
    const base = rawBase || `файл-${++pasteSeq}`;
    return new File([file], `${base}.${ext}`, { type: file.type });
  }
  return file;
}

export function isAccepted(file: { name: string }): boolean {
  const lower = file.name.toLowerCase();
  return ACCEPT_EXT.some((ext) => lower.endsWith(ext));
}

// Stable identity for a staged file (dedupe + chip key + removal). Two <input>
// picks of the same file on the same day collapse to one pending chip.
export function fileKey(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

// Normalize + filter dropped/pasted files down to the supported types. Returns a
// plain File[] (no DataTransfer round-trip — that can silently drop filenames,
// which the server's extension allow-list then rejects).
export function acceptFiles(files: File[]): File[] {
  return files.map(normalizeDropped).filter(isAccepted);
}

/** Drop oversize files and split the rest into count- AND byte-bounded batches. */
export function planUpload<F extends { name: string; size: number }>(all: F[]): { batches: F[][]; skipped: F[] } {
  const skipped: F[] = [];
  const batches: F[][] = [];
  let cur: F[] = [];
  let curBytes = 0;
  for (const f of all) {
    if (f.size > (isZip(f) ? MAX_ZIP_BYTES : MAX_FILE_BYTES)) {
      skipped.push(f);
      continue;
    }
    if (cur.length && (cur.length >= CLIENT_BATCH_FILES || curBytes + f.size > CLIENT_BATCH_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += f.size;
  }
  if (cur.length) batches.push(cur);
  return { batches, skipped };
}

/** The user-facing summary of an upload (empty string = nothing to say). */
export function uploadReport(
  failure: string | null,
  rejected: { name: string; reason: string }[],
  skipped: { name: string; size: number }[],
): string {
  const skippedText = skipped.length
    ? "Пропущено — файл завеликий (макс. 100 МБ, архів .zip — 200 МБ):\n" +
      skipped.map((f) => `• ${f.name} — ${fmtMb(f.size)}`).join("\n")
    : "";
  return [
    failure,
    rejected.length ? "Відхилено:\n" + rejected.map((r) => `• ${r.name} — ${r.reason}`).join("\n") : "",
    skippedText,
  ]
    .filter(Boolean)
    .join("\n\n");
}
