/**
 * The fixed customs document-package folder skeleton. New workspaces are seeded
 * with these folders so the file tree matches the UI's expectations. The former
 * 10-folder layout was consolidated to 8 (Contract/Invoice/Packing List merged),
 * then to 7 (the two certificate folders merged into 03_Certificates); existing
 * workspaces are migrated by `db/migrateFolderSkeleton.ts` then `db/migrateCertMerge.ts`.
 */
// NB: the former '02_PO' folder was removed — these supplies are governed by the
// contract, not a separate purchase order. Existing workspaces keep any 02_PO
// folder they already have (harmless); new ones are not seeded with it.
export const FOLDER_SKELETON = [
  '01_Contract_Invoice_PackingList',
  '03_Certificates',
  '04_Customs',
  '05_Transport',
  '06_Photos',
  '07_Final',
] as const;

/**
 * The folder skeleton for an FCL (Збірник, spec 006). Only the FCL-level folders:
 * each lot gets its own folder («Партія — <постачальник>») when the lot is created.
 * Collections created before spec 006 keep their old 8-folder layout; folder roles
 * are found by name (`fclFolderRole`), so both layouts work.
 */
export const FCL_FOLDER_SKELETON = ['01_Митниця', '02_Транспорт'] as const;

/** Sub-folder names of the FCL layout (spec 007). */
export const FCL_COMMON_FOLDER = 'Весь контейнер';
export const LOT_OTHER_FOLDER = 'Інше';

export type FclFolderRole = 'manifest' | 'transport' | 'customs';

/** The FCL role of a folder by its name, for both the new and the legacy layout. */
export function fclFolderRole(name: string): FclFolderRole | null {
  if (/маніфест/i.test(name)) return 'manifest';
  if (/транспорт/i.test(name)) return 'transport';
  if (/митниц/i.test(name)) return 'customs';
  return null;
}

/** The folder name of a lot. */
export function lotFolderName(lotName: string): string {
  return `Партія — ${lotName}`;
}

export type FileType = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'image' | 'md';

/** Infer the stored file type from a filename, matching the prototype rules. */
export function inferFileType(name: string): FileType {
  const n = name.toLowerCase();
  if (n.endsWith('.md')) return 'md';
  if (/\.(xlsx|xls)$/.test(n)) return 'xlsx';
  if (/\.csv$/.test(n)) return 'csv';
  if (/\.(docx|doc)$/.test(n)) return 'docx';
  if (/\.(png|jpg|jpeg|gif|webp)$/.test(n)) return 'image';
  return 'pdf';
}
