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

/**
 * The folder skeleton for Collections (Збірник / consolidated cargo). Distinct
 * from the workspace skeleton above — collections group documents for a
 * multi-supplier consolidated shipment rather than a single reconciliation.
 */
export const COLLECTION_FOLDER_SKELETON = [
  '01_Маніфест',
  '02_Інвойси',
  '03_Сертифікати_походження',
  '04_MSDS_SDS',
  '05_Якість_CoA',
  '06_Дозволи_ліцензії',
  '07_Транспорт',
  '08_Митниця',
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
