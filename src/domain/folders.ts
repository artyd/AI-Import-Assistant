/**
 * The fixed customs document-package folder skeleton. New workspaces are seeded
 * with these folders so the file tree matches the UI's expectations. The former
 * 10-folder layout was consolidated to 8 (Contract/Invoice/Packing List merged);
 * existing workspaces are migrated by `db/migrateFolderSkeleton.ts`.
 */
export const FOLDER_SKELETON = [
  '01_Contract_Invoice_PackingList',
  '02_PO',
  '03_Certificate_of_Origin',
  '04_Quality_Certificates',
  '05_Customs',
  '06_Transport',
  '07_Photos',
  '08_Final',
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
