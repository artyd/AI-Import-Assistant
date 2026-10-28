// Display-only Ukrainian labels for the fixed customs folder skeleton.
//
// The backend keeps the stable code names (`01_Contract_Invoice_PackingList`, …)
// because classification, the completeness checklist and the export zip key off
// them. This map only makes the tree readable in the UI — unknown names
// (user-created folders) pass through unchanged.
const FOLDER_LABELS: Record<string, string> = {
  "01_Contract_Invoice_PackingList": "Контракт, інвойс, пакувальний",
  // '02_PO' folder was removed from the skeleton; kept here so any legacy folder
  // still renders a readable label instead of its raw code name.
  "02_PO": "Замовлення",
  "03_Certificates": "Сертифікати",
  "04_Customs": "Митна декларація",
  "05_Transport": "Транспортні документи",
  "06_Photos": "Фото",
  "07_Final": "Фінальні документи",
};

/** A folder as a person sees it: no numbering (spec 007). */
export function folderLabel(name: string): string {
  return FOLDER_LABELS[name] ?? name.replace(/^\d{1,2}[_ .-]+/, "");
}
