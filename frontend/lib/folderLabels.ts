// Display-only Ukrainian labels for the fixed customs folder skeleton.
//
// The backend keeps the stable code names (`01_Contract_Invoice_PackingList`, …)
// because classification, the completeness checklist and the export zip key off
// them. This map only makes the tree readable in the UI — unknown names
// (user-created folders) pass through unchanged.
const FOLDER_LABELS: Record<string, string> = {
  "01_Contract_Invoice_PackingList": "01 · Контракт, інвойс, пакувальний",
  // '02_PO' folder was removed from the skeleton; kept here so any legacy folder
  // still renders a readable label instead of its raw code name.
  "02_PO": "02 · Замовлення",
  "03_Certificates": "03 · Сертифікати",
  "04_Customs": "04 · Митна декларація",
  "05_Transport": "05 · Транспортні документи",
  "06_Photos": "06 · Фото",
  "07_Final": "07 · Фінальні документи",
};

export function folderLabel(name: string): string {
  return FOLDER_LABELS[name] ?? name;
}
