import type { CheckItem, InstructionDraft } from './types.js';

/**
 * Typical document package and label fields per product category (the mockup's
 * base sets, refined). qdpro adds code-specific items on top in prefill.ts.
 */
type Base = { key: string; en: string; uk: string; on?: boolean };

const DOCS_COMMON: Base[] = [
  { key: 'invoice_pl', en: 'Invoice and Packing List', uk: 'Інвойс і пакувальний лист' },
  { key: 'coo', en: 'Certificate of Origin', uk: 'Сертифікат походження' },
  { key: 'export_decl', en: 'Copy of the export declaration', uk: 'Копія експортної декларації' },
  { key: 'insurance', en: 'Insurance policy', uk: 'Страховий поліс', on: false },
];

const DOCS_BY_CATEGORY: Record<InstructionDraft['category'], Base[]> = {
  substance: [
    { key: 'coa', en: 'Certificate of Analysis', uk: 'Сертифікат аналізу (COA)' },
    { key: 'msds', en: 'Material Safety Data Sheet', uk: 'Паспорт безпеки (MSDS)' },
  ],
  finished: [
    { key: 'coa', en: 'Certificate of Analysis', uk: 'Сертифікат аналізу (COA)' },
    { key: 'gmp', en: 'GMP certificate of the manufacturer', uk: 'GMP-сертифікат виробника' },
  ],
  chemical: [
    { key: 'coa', en: 'Certificate of Analysis', uk: 'Сертифікат аналізу (COA)' },
    { key: 'msds', en: 'Material Safety Data Sheet', uk: 'Паспорт безпеки (MSDS)' },
  ],
  food: [
    { key: 'coa', en: 'Certificate of Analysis', uk: 'Сертифікат аналізу (COA)' },
    { key: 'vet', en: 'International veterinary certificate', uk: 'Міжнародний ветеринарний сертифікат' },
    { key: 'phyto', en: 'Phytosanitary certificate', uk: 'Фітосанітарний сертифікат' },
  ],
  other: [],
};

const LABELS_COMMON: Base[] = [
  { key: 'name', en: 'Product name', uk: 'Назва товару' },
  { key: 'manufacturer', en: 'Manufacturer name and address', uk: 'Назва та адреса виробника' },
  { key: 'batch', en: 'Batch number', uk: 'Номер партії' },
  { key: 'dates', en: 'Manufacturing and expiry dates', uk: 'Дата виробництва / придатності' },
  { key: 'weight', en: 'Net / gross weight', uk: 'Вага нетто / брутто' },
  { key: 'carton', en: 'Carton No. X / Y, where Y is the actual number of packages in this shipment', uk: 'Місце X з Y (Y = фактична кількість місць)' },
];
const LABELS_BY_CATEGORY: Record<InstructionDraft['category'], Base[]> = {
  substance: [
    { key: 'cas', en: 'CAS number', uk: 'CAS-номер' },
    { key: 'storage', en: 'Storage conditions', uk: 'Умови зберігання' },
  ],
  finished: [
    { key: 'reg', en: 'Ukrainian registration number', uk: 'Український реєстраційний номер' },
    { key: 'storage', en: 'Storage conditions', uk: 'Умови зберігання' },
  ],
  chemical: [
    { key: 'cas', en: 'CAS number', uk: 'CAS-номер' },
    { key: 'hazard', en: 'Hazard pictograms (GHS)', uk: 'Піктограми небезпеки (GHS)' },
  ],
  food: [{ key: 'storage', en: 'Storage conditions', uk: 'Умови зберігання' }],
  other: [],
};

const toItem = (b: Base): CheckItem => ({ key: b.key, label: b.en, labelUk: b.uk, checked: b.on ?? true, source: 'base' });

export function baseDocs(category: InstructionDraft['category']): CheckItem[] {
  return [...DOCS_COMMON.slice(0, 2), ...DOCS_BY_CATEGORY[category], ...DOCS_COMMON.slice(2)].map(toItem);
}
export function baseLabels(category: InstructionDraft['category']): CheckItem[] {
  return [...LABELS_COMMON.slice(0, 1), ...LABELS_BY_CATEGORY[category], ...LABELS_COMMON.slice(1)].map(toItem);
}

/** Code-specific requirements from qdpro flags → items the SUPPLIER must provide. */
export function qdproDocs(flags: { vet_control: boolean; phyto: boolean; dual_use: boolean; license: boolean }): CheckItem[] {
  const out: CheckItem[] = [];
  if (flags.vet_control) out.push({ key: 'vet', label: 'International veterinary certificate', labelUk: 'Міжнародний ветеринарний сертифікат', checked: true, source: 'qdpro' });
  if (flags.phyto) out.push({ key: 'phyto', label: 'Phytosanitary certificate', labelUk: 'Фітосанітарний сертифікат', checked: true, source: 'qdpro' });
  if (flags.dual_use) out.push({ key: 'dualuse', label: 'Dual-use goods end-user statement', labelUk: 'Заява кінцевого користувача (подвійне призначення)', checked: true, source: 'qdpro' });
  else out.push({ key: 'dualuse', label: 'Dual-use (non-controlled goods) statement', labelUk: 'Лист про невіднесення до товарів подвійного призначення', checked: true, source: 'qdpro' });
  if (flags.license) out.push({ key: 'license', label: 'Copy of the export licence', labelUk: 'Копія експортної ліцензії', checked: true, source: 'qdpro' });
  return out;
}

export function emptyDraft(): InstructionDraft {
  return {
    from: { directoryId: null, name: '', address: '', signer: '', email: '', phone: '' },
    category: 'substance',
    product: { name: '', grade: '', cas: '', quantity: '', unit: 'kg', hsCode: '', regNumber: '' },
    consignor: { name: '', address: '', country: '' },
    consigneeChoice: 'recipient',
    consignee: { name: '', address: '', country: '' },
    finalConsignee: '',
    contract: { number: '', date: '' },
    terms: { incoterm: '', place: '', destination: '', finalDestination: '', transport: 'air' },
    docs: baseDocs('substance'),
    labels: baseLabels('substance'),
    labelNotes: '',
    originals: { contact: '', phone: '', address: '' },
    supplierEmail: '',
    extra: [],
    sources: {},
    proposals: [],
    hints: { contractType: null, intermediary: '', recipient: '', qdproSummary: '', lessons: [] },
  };
}
