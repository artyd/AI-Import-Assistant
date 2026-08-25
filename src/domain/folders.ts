/**
 * The fixed customs document-package folder skeleton. New workspaces are seeded
 * with these folders so the file tree matches the UI's expectations. The former
 * 10-folder layout was consolidated to 8 (Contract/Invoice/Packing List merged),
 * then to 7 (the two certificate folders merged into 03_Certificates); existing
 * workspaces are migrated by `db/migrateFolderSkeleton.ts` then `db/migrateCertMerge.ts`.
 */
export const FOLDER_SKELETON = [
  '01_Contract_Invoice_PackingList',
  '02_PO',
  '03_Certificates',
  '04_Customs',
  '05_Transport',
  '06_Photos',
  '07_Final',
] as const;

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
