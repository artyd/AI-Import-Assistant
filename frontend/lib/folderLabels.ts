// Display-only Ukrainian labels for the fixed customs folder skeleton.
//
// The backend keeps the stable code names (`01_Contract_Invoice_PackingList`, …)
// because classification, the completeness checklist and the export zip key off
// them. This map only makes the tree readable in the UI — unknown names
// (user-created folders) pass through unchanged.
const FOLDER_LABELS: Record<string, string> = {
  "01_Contract_Invoice_PackingList": "01 · Контракт, інвойс, пакувальний",
  "02_PO": "02 · Замовлення (PO)",
  "03_Certificates": "03 · Сертифікати",
  "04_Customs": "04 · Митна декларація",
  "05_Transport": "05 · Транспортні документи",
  "06_Photos": "06 · Фото",
  "07_Final": "07 · Фінальні документи",
};

export function folderLabel(name: string): string {
  return FOLDER_LABELS[name] ?? name;
}
