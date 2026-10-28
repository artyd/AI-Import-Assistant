import { docProducts } from '../shipments/fclLayout.js';
import type { AssignFields } from '../shipments/lotAssign.js';

/** Human names of the document types, for the reading journal. */
export const DOC_TYPE_UA: Record<string, string> = {
  invoice: 'інвойс',
  packing_list: 'пакувальний лист',
  contract: 'контракт',
  certificate_of_origin: 'сертифікат походження',
  quality_certificate: 'сертифікат якості / аналізу',
  customs_declaration: 'митна декларація',
  transport: 'транспортний документ',
  label: 'маркування / етикетка',
  instruction: 'інструкція',
  veterinary: 'вет. / реєстраційний документ',
  photos: 'фото',
  other: 'документ',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * One journal line about what a document turned out to be:
 * "інвойс № 12 від Shandong X → AGroup95, 3 товари: Paracetamol, Ascorbic acid, …".
 */
export function describeDocument(fields: (AssignFields & Record<string, unknown>) | null): string {
  if (!fields) return 'полів не знайдено';
  const type = str(fields.doc_type) ?? 'other';
  const parts: string[] = [DOC_TYPE_UA[type] ?? type];
  const kind = str(fields.transport_doc_kind);
  if (type === 'transport' && kind && kind !== 'other') parts[0] = `${parts[0]} (${kind.toUpperCase()})`;
  const number = str(fields.invoice_number) ?? str(fields.transport_doc_number) ?? str(fields.contract_number);
  if (number) parts.push(`№ ${number}`);
  const seller = str(fields.seller) ?? str(fields.consignor_name) ?? str(fields.manufacturer);
  const buyer = str(fields.buyer) ?? str(fields.consignee_name);
  if (seller) parts.push(`від ${seller}${buyer ? ` → ${buyer}` : ''}`);
  const products = docProducts(fields);
  if (products.length === 1) parts.push(`товар: ${products[0]!.name}`);
  else if (products.length > 1) {
    const names = products.slice(0, 4).map((p) => p.name).join(', ');
    parts.push(`${products.length} товари: ${names}${products.length > 4 ? ', …' : ''}`);
  }
  const batch = str(fields.batch_number);
  if (batch) parts.push(`партія товару ${batch}`);
  return parts.join(', ');
}
