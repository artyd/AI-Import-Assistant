"use client";

export const UPLOAD_ACCEPT = ".pdf,.docx,.doc,.xlsx,.xls,.csv,.png,.jpg,.jpeg";
const ACCEPT_EXT = UPLOAD_ACCEPT.split(",").map((s) => s.trim().toLowerCase());

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

function isAccepted(file: File): boolean {
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
