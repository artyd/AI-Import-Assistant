import { describe, expect, it } from 'vitest';
import {
  assignLot,
  buildLotProfiles,
  isInternalCompany,
  lotNameFor,
  sameGoods,
  transportDocKind,
  type AssignDoc,
} from '../lotAssign.js';

const doc = (file_name: string, fields: Record<string, unknown> | null, file_type = 'pdf'): AssignDoc => ({
  file_name,
  file_type,
  fields,
});

// «Сборник 18»-like FCL: two Chinese suppliers already have lots.
const lots = buildLotProfiles(
  [
    { id: 'L1', name: 'Shandong Betaine', supplier_name: 'Shandong Betaine Co., Ltd' },
    { id: 'L2', name: 'Hebei Pharm', supplier_name: 'Hebei Pharm Import & Export Co., Ltd' },
  ],
  [
    {
      lot_id: 'L1',
      fields: {
        doc_type: 'invoice',
        seller: 'Shandong Betaine Co., Ltd',
        product_name: 'Betaine anhydrous',
        manufacturer: 'Shandong Betaine Co., Ltd',
        line_items: [{ description: 'Betaine Anhydrous 98%', batch_no: 'SB2601' }],
      },
    },
    {
      lot_id: 'L2',
      fields: {
        doc_type: 'invoice',
        seller: 'Hebei Pharm Import & Export Co., Ltd',
        manufacturer: 'Hebei Jiheng Pharmaceutical',
        line_items: [{ description: 'Paracetamol USP powder' }, { description: 'Caffeine anhydrous' }],
      },
    },
  ],
);

describe('sameGoods — spellings of one product', () => {
  it('HCl = hydrochloride, PEG-1500 = polyethylene glycol PEG 1500', () => {
    expect(sameGoods('D-Glucosamine HCl', 'D-Glucosamine Hydrochloride')).toBe(true);
    expect(sameGoods('Глюкозаміну гідрохлорид', 'Glucosamine HCl')).toBe(false); // different scripts stay apart
    expect(sameGoods('PEG-1500', 'POLYETHYLENE GLYCOL PEG 1500')).toBe(true);
  });

  it('keeps D- and DL- forms apart', () => {
    expect(sameGoods('DL-Aspartic acid', 'D-Aspartic acid')).toBe(false);
  });
});

describe('assignLot', () => {
  it('files transport, customs and the manifest at the FCL level', () => {
    expect(assignLot(doc('HBL BW26010230A.pdf', { doc_type: 'transport' }), lots)).toMatchObject({ kind: 'fcl', folder: 'transport' });
    expect(assignLot(doc('MD.pdf', { doc_type: 'customs_declaration' }), lots)).toMatchObject({ kind: 'fcl', folder: 'customs' });
    expect(assignLot(doc('Маніфест збірника.xlsx', null, 'xlsx'), lots)).toMatchObject({ kind: 'fcl', folder: 'manifest' });
  });

  it('puts an invoice into the lot of its seller', () => {
    const r = assignLot(doc('inv.pdf', { doc_type: 'invoice', seller: 'SHANDONG BETAINE CO LTD' }), lots);
    expect(r).toMatchObject({ kind: 'lot', lotId: 'L1', confidence: 'high' });
  });

  it('opens a new lot for a new supplier on an anchor document', () => {
    const r = assignLot(doc('ci.pdf', { doc_type: 'contract', seller: 'Jiangsu Zhongbang Chemical Co., Ltd' }), lots);
    expect(r).toEqual(expect.objectContaining({ kind: 'new', supplierName: 'Jiangsu Zhongbang Chemical Co., Ltd' }));
  });

  it('routes our own resale invoice (Prime Force → consignee) by the goods', () => {
    const r = assignLot(
      doc('PF invoice.pdf', {
        doc_type: 'invoice',
        seller: 'PRIME FORCE UK BUSINESS LTD',
        line_items: [{ description: 'Paracetamol powder USP' }],
      }),
      lots,
    );
    expect(r).toMatchObject({ kind: 'lot', lotId: 'L2', confidence: 'medium' });
  });

  it('our resale paper over goods of several lots goes to the FCL customs folder', () => {
    const r = assignLot(
      doc('Прайм_Новалайт инвойс_упак.pdf', {
        doc_type: 'invoice',
        seller: 'PRIME FORCE UK BUSINESS LTD',
        line_items: [{ description: 'Betaine anhydrous 98%' }, { description: 'Paracetamol USP powder' }],
      }),
      lots,
    );
    expect(r).toMatchObject({ kind: 'fcl', folder: 'customs' });
  });

  it('never makes our own company a supplier lot', () => {
    const r = assignLot(doc('PF invoice.pdf', { doc_type: 'invoice', seller: 'Prime Force UK', product_name: 'Glycine' }), lots);
    expect(r.kind).toBe('inbox');
  });

  it('matches a CoA by batch number, then by goods', () => {
    expect(assignLot(doc('coa.pdf', { doc_type: 'quality_certificate', batch_number: 'sb2601' }), lots)).toMatchObject({ kind: 'lot', lotId: 'L1' });
    expect(assignLot(doc('coa2.pdf', { doc_type: 'quality_certificate', product_name: 'Caffeine Anhydrous' }), lots)).toMatchObject({ kind: 'lot', lotId: 'L2' });
  });

  it('the goods win over a batch number that points to another lot', () => {
    const r = assignLot(
      doc('Label Paracetamol.pdf', { doc_type: 'other', product_name: 'Paracetamol USP', batch_number: 'SB2601' }),
      lots,
    );
    expect(r).toMatchObject({ kind: 'lot', lotId: 'L2', confidence: 'medium' });
  });

  it('does not create a lot from a certificate', () => {
    const r = assignLot(doc('coo.pdf', { doc_type: 'certificate_of_origin', seller: 'Unknown Trading Co' }), lots);
    expect(r.kind).toBe('inbox');
  });

  it('keeps an ambiguous document in the inbox with a suggestion', () => {
    const two = buildLotProfiles(
      [
        { id: 'A', name: 'A', supplier_name: 'Alpha Chem' },
        { id: 'B', name: 'B', supplier_name: 'Beta Chem' },
      ],
      [
        { lot_id: 'A', fields: { product_name: 'Glycine' } },
        { lot_id: 'B', fields: { product_name: 'Glycine' } },
      ],
    );
    const r = assignLot(doc('msds.pdf', { doc_type: 'quality_certificate', product_name: 'Glycine' }), two);
    expect(r).toMatchObject({ kind: 'inbox', suggestLotId: 'A' });
  });
});

describe('helpers', () => {
  it('reads the transport document kind from the extraction, else the name', () => {
    expect(transportDocKind('x.pdf', { transport_doc_kind: 'mbl' })).toBe('mbl');
    expect(transportDocKind('HBL_BW26010230A.pdf', {})).toBe('hbl');
    expect(transportDocKind('T1 MRN 26PL.pdf', {})).toBe('transit');
    expect(transportDocKind('CMR 123.pdf', null)).toBe('cmr');
    expect(transportDocKind('scan.pdf', null)).toBeNull();
  });

  it('compares goods by CAS or by tokens', () => {
    expect(sameGoods('Betaine 107-43-7', 'BETAINE ANHYDROUS 107-43-7')).toBe(true);
    expect(sameGoods('Glycine 56-40-6', 'Betaine 107-43-7')).toBe(false);
    expect(sameGoods('Paracetamol USP', 'Caffeine anhydrous')).toBe(false);
  });

  it('knows our own companies and shortens lot names', () => {
    expect(isInternalCompany('PRIME FORCE UK BUSINESS LTD')).toBe(true);
    expect(isInternalCompany('Hebei Pharm')).toBe(false);
    expect(lotNameFor('Hebei Pharm Import & Export Co., Ltd')).toBe('Hebei Pharm');
  });
});
