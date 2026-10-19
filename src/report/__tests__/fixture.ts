import type { FactsInput } from '../facts.js';

// Метопрен (TEST-Метопрен v2) — the figures the report must reproduce.
export const base: FactsInput = {
  workspace: { number: 'TEST-Метопрен', status: 'draft', contract_type: 'trilateral', product_category: null, transport_mode: 'multimodal' },
  responsible: 'Тест Користувач',
  parties: [
    { role: 'sender', company_name: 'NGL Fine-Chem Limited', country: 'India' },
    { role: 'intermediary', company_name: 'PRIME FORCE UK BUSINESS LIMITED', country: 'United Kingdom' },
    { role: 'recipient', company_name: '«TEKHINFORM PLUS» LLC / ТОВ «ТЕХІНФОРМ ПЛЮС»', country: 'Ukraine' },
  ],
  docs: [
    { file_name: '03062026PTM.pdf', doc_type: 'contract', fields: { seller: 'PRIME FORCE UK BUSINESS LIMITED', buyer: 'TEKHINFORM PLUS', contract_number: '03062026/PTM', document_date: '2026-06-03' } },
    { file_name: 'INVOICE.pdf', doc_type: 'invoice', fields: { seller: 'NGL Fine-Chem Limited', buyer: 'PRIME FORCE UK BUSINESS LIMITED', total_value: 13125, currency: 'USD', incoterm: 'FCA Mumbai Airport', document_date: '2026-07-09' } },
    { file_name: 'Inv PL S-METHOPRENE.pdf', doc_type: 'invoice', fields: { seller: 'PRIME FORCE UK BUSINESS LIMITED', buyer: '"TEKHINFORM PLUS" LLC', total_value: 8750, currency: 'USD', incoterm: 'CPT Bila Tzerkva, Ukraine', document_date: '2026-07-09', product_name: 'S-METHOPRENE', line_items: [{ description: 'S-METHOPRENE', quantity: 25, unit: 'kg' }] } },
    { file_name: 'COA.pdf', doc_type: 'quality_certificate', fields: { document_date: '22.06.2026', batch_number: 'SMP/06/012/2026', manufacture_date: '2026-06', expiry_date: '2029-05', cas_number: '65733-16-6' } },
    { file_name: 'AIRWAY BILL.PDF', doc_type: 'transport', fields: { transport_mode: 'air', transport_doc_number: '098-31298724', place_of_loading: 'Mumbai, India', place_of_discharge: 'Frankfurt', shipment_date: '2026-07-14' } },
    { file_name: 'CMR - SAID0009199.pdf', doc_type: 'transport', fields: { transport_mode: 'road', transport_doc_number: 'SAID0009199', place_of_loading: 'Frankfurt', place_of_discharge: 'Kyiv, Ukraine', document_date: '2026-07-23' } },
    { file_name: 'IMG_7217.jpeg', doc_type: 'transport', fields: { transport_mode: 'courier', transport_doc_number: '20400540693174', place_of_discharge: 'Bila Tserkva', document_date: '2026-07-31', delivery_deadline: '2026-08-01' } },
    { file_name: '26UA100100040301U3.pdf', doc_type: 'customs_declaration', fields: { document_date: '31.07.2026', registration_number: '26UA100100040301U3', customs_value_uah: 391051.5, duty_uah: 25418.35, vat_uah: 83293.97, exchange_rate: 44.6916, hs_code: '2918999090', packages_count: 3, gross_weight_kg: 32, net_weight_kg: 25 } },
    { file_name: 'рахунок 42.pdf', doc_type: 'other', fields: { service_kind: 'broker', total_value: 6163, currency: 'UAH', buyer: 'ТОВ «ТЕХІНФОРМ ПЛЮС»' } },
    { file_name: 'СчетНаОплатуПокупателю.pdf', doc_type: 'other', fields: { service_kind: 'freight', total_value: 913.48, currency: 'USD', buyer: 'PRIME FORCE UK BUSINESS LIMITED' } },
  ],
  checklist: [
    { requirement_key: 'invoice', status: 'verified' },
    { requirement_key: 'intermediary_agreement', status: 'verified' },
  ],
  risks: [
    { severity: 'error', category: 'discrepancy', title: 'Розбіжність: націнка посередника', detail: '…' },
    { severity: 'error', category: 'discrepancy', title: 'Розбіжність: вага нетто', detail: '…' },
    { severity: 'warning', category: 'discrepancy', title: 'Розбіжність: вага брутто', detail: '…' },
    { severity: 'warning', category: 'discrepancy', title: 'Розбіжність: документи', detail: 'один документ цього типу → …' },
    { severity: 'info', category: 'registry', title: 'x', detail: 'y' },
  ],
  filesCount: 28,
  qdpro: null,
  now: new Date(Date.UTC(2026, 9, 5)),
};

