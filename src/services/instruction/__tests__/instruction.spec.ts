import { describe, it, expect } from 'vitest';
import { emptyDraft, baseDocs } from '../defaults.js';
import { renderText, letterSubject } from '../render.js';
import { checkInstructionCompliance, type ComplianceDoc } from '../compliance.js';
import { missingFields, setPath, draftSchema, type InstructionDraft } from '../types.js';

// The real Метопрен instruction as it would be built before shipment.
function metoprene(): InstructionDraft {
  const d = emptyDraft();
  d.from = { directoryId: null, name: '«TEKHINFORM PLUS» LLC', address: 'Kharkiv', signer: 'Тест Користувач', email: '', phone: '' };
  d.product = { name: 'S-METHOPRENE', grade: 'Technical ≥ 98%', cas: '65733-16-6', quantity: '25', unit: 'kg', hsCode: '2918 99 90 90', regNumber: '' };
  d.consignor = { name: 'NGL Fine-Chem Limited', address: 'Navi Mumbai 400705', country: 'India' };
  d.consigneeChoice = 'intermediary';
  d.consignee = { name: 'PRIME FORCE UK BUSINESS LIMITED', address: '22 Brondesbury Park, London', country: 'United Kingdom' };
  d.finalConsignee = '«TEKHINFORM PLUS» LLC, Kharkiv, Ukraine';
  d.contract = { number: '03062026/PNM', date: '03.06.2026' };
  d.terms = { incoterm: 'FCA', place: 'Mumbai Airport, India', destination: 'Kyiv Boryspil (KBP)', finalDestination: 'Kharkiv, Ukraine', transport: 'air' };
  d.docs = baseDocs('substance');
  d.docs.find((x) => x.key === 'insurance')!.checked = true; // as in the original instruction
  d.originals = { contact: 'Тест Користувач', phone: '+380 57 700 00 00', address: '14-A Frankivska St., Kharkiv' };
  return d;
}

describe('instruction render', () => {
  it('EN letter: deterministic, all sections, no placeholders when complete', () => {
    const d = metoprene();
    const a = renderText(d, 'en');
    expect(a).toBe(renderText(d, 'en'));
    expect(a).toContain('Please confirm our shipping instructions for S-METHOPRENE, Technical ≥ 98%, CAS 65733-16-6, 25 kg (HS code 2918 99 90 90).');
    expect(a).toContain('Terms of delivery: FCA Mumbai Airport, India');
    expect(a).toContain('- Draft of the MAWB and HAWB');
    expect(a).toContain('Carton No. X / Y, where Y is the actual number of packages');
    expect(a).toContain('- Certificate of Origin (original, wet seal)');
    expect(a).toContain('Please send the insurance policy as well.');
    expect(a).not.toMatch(/\[[A-Z .]+\]/);
  });

  it('missing fields become visible placeholders and are listed', () => {
    const d = setPath(metoprene(), 'originals.phone', '');
    expect(renderText(d, 'en')).toContain('tel. [PHONE]');
    expect(missingFields(d).map((m) => m.path)).toEqual(['originals.phone']);
  });

  it('UK version is the internal check copy', () => {
    const uk = renderText(metoprene(), 'uk');
    expect(uk).toContain('постачальнику не надсилається');
    expect(uk).toContain('Умови поставки: FCA Mumbai Airport, India');
  });

  it('subject + schema defaults', () => {
    expect(letterSubject(metoprene())).toBe('Shipping instructions — S-METHOPRENE 25 kg / 03062026/PNM');
    expect(draftSchema.parse(JSON.parse(JSON.stringify(metoprene())))).toBeTruthy();
  });
});

describe('instruction compliance — Метопрен', () => {
  const doc = (file_name: string, doc_type: string, fields: Record<string, unknown>): ComplianceDoc => ({ file_id: file_name, file_name, doc_type, fields });
  const docs: ComplianceDoc[] = [
    doc('AIRWAY BILL.PDF', 'transport', { transport_mode: 'air', parties: [{ name: 'TEKHINFORM PLUS LLC', role: 'Consignee' }] }),
    doc('COO.pdf', 'certificate_of_origin', { parties: [{ name: 'TEKHINFORM PLUS LLC', role: 'consignee' }] }),
    doc('INVOICE.pdf', 'invoice', { seller: 'NGL Fine-Chem Limited', incoterm: 'FCA BY AIR MUMBAI AIRPORT', final_destination: "Kiev Int'l Airport" }),
    doc('PACKING LIST.pdf', 'packing_list', { final_destination: "KIEV INT'L AIRPORT" }),
    doc('COA.pdf', 'quality_certificate', {}),
    doc('S-METHOPRENE MSDS.pdf', 'quality_certificate', {}),
  ];

  it('flags consignee ≠ PRIME, Kyiv ≠ Kharkiv, missing insurance + export declaration; FCA matches', () => {
    const f = checkInstructionCompliance(metoprene(), docs, 2);
    const text = f.map((x) => `${x.severity} ${x.expected} | ${x.actual}`).join('\n');
    expect(f.find((x) => x.expected.includes('consignee'))?.severity).toBe('error');
    expect(text).toContain('TEKHINFORM PLUS LLC');
    expect(text).toContain('кінцевий пункт');
    expect(text).toMatch(/не надано: .*Копія експортної декларації.*Страховий поліс|не надано: .*Страховий поліс/);
    expect(text).not.toContain('умови поставки');
  });

  it('before any shipping document arrives there is nothing to check', () => {
    expect(checkInstructionCompliance(metoprene(), [doc('c.pdf', 'contract', {})], 1)).toEqual([]);
  });
});

import { isProposablePath } from '../types.js';
describe('instruction draft guards', () => {
  it('only whitelisted string fields can be proposed', () => {
    expect(isProposablePath('originals.phone')).toBe(true);
    expect(isProposablePath('constructor.name')).toBe(false);
    expect(isProposablePath('hints.qdproSummary')).toBe(false);
    expect(isProposablePath('docs.0.label')).toBe(false);
  });
  it('schema bounds oversized input', () => {
    const d = metoprene();
    expect(draftSchema.safeParse({ ...d, labelNotes: 'x'.repeat(5000) }).success).toBe(false);
    expect(draftSchema.safeParse({ ...d, extra: Array.from({ length: 11 }, () => ({ en: 'a', uk: 'b' })) }).success).toBe(false);
  });
});
