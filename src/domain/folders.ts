/**
 * The fixed customs document-package folder skeleton, mirroring the prototype's
 * `SKELETON` array. New workspaces are seeded with these folders so the file
 * tree matches the UI's expectations.
 */
export const FOLDER_SKELETON = [
  '01_Contract',
  '02_PO',
  '03_Invoice',
  '04_Packing_List',
  '05_Certificate',
  '06_Quality_Certificates',
  '07_Customs',
  '08_Transport',
  '09_Photos',
  '10_Final',
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
