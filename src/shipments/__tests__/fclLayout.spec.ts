import { describe, expect, it } from 'vitest';
import { docProducts, findProductFolder, placeInLot, createsProducts, shortProductName, productFolderByFileName } from '../fclLayout.js';

describe('fclLayout', () => {
  it('customs papers go to the lot customs folder, the rest to the product', () => {
    expect(placeInLot('invoice')).toBe('lot_customs');
    expect(placeInLot('packing_list')).toBe('lot_customs');
    expect(placeInLot('certificate_of_origin')).toBe('lot_customs');
    expect(placeInLot('label')).toBe('lot_customs');
    expect(placeInLot('quality_certificate')).toBe('product');
    expect(placeInLot('other')).toBe('product');
    expect(placeInLot(null)).toBe('product');
    expect(createsProducts('invoice')).toBe(true);
    expect(createsProducts('quality_certificate')).toBe(false);
  });

  it('short product names drop packing and quantities', () => {
    expect(shortProductName('Paracetamol USP 25kg/drum (Batch 2301)')).toBe('Paracetamol USP');
    expect(shortProductName('Ascorbic acid, 25 kg bags')).toBe('Ascorbic acid');
    expect(shortProductName('BETAINE HCL 98% CAS 590-46-5')).toBe('BETAINE HCL 98%');
  });

  it('products of an invoice: one per product, CAS kept, duplicates merged', () => {
    const products = docProducts({
      doc_type: 'invoice',
      line_items: [
        { description: 'Paracetamol USP 25kg/drum', product_name: 'Paracetamol', cas_number: '103-90-2' },
        { description: 'Paracetamol USP 25kg/drum (2nd lot)', product_name: 'Paracetamol', cas_number: '103-90-2' },
        { description: 'Ascorbic acid 25 kg bags' },
      ],
    });
    expect(products).toEqual([
      { name: 'Paracetamol', cas: '103-90-2' },
      { name: 'Ascorbic acid', cas: null },
    ]);
  });

  it('a CoA finds its product folder by CAS or by name', () => {
    const folders = [
      { id: 'p1', product_key: 'Paracetamol 103-90-2' },
      { id: 'p2', product_key: 'Ascorbic acid' },
    ];
    expect(findProductFolder(folders, { name: 'Acetaminophen', cas: '103-90-2' })?.id).toBe('p1');
    expect(findProductFolder(folders, { name: 'Ascorbic Acid', cas: null })?.id).toBe('p2');
    expect(findProductFolder(folders, { name: 'Glycine', cas: '56-40-6' })).toBeNull();
  });

  it('a photo goes by its file name only when one product fits', () => {
    const folders = [
      { id: 'g', product_key: 'D-Glucosamine Hydrochloride' },
      { id: 'a', product_key: 'DL-ASPARTIC ACID' },
      { id: 'c', product_key: 'Ascorbic acid' },
    ];
    expect(productFolderByFileName(folders, '026_photo of D-Glucosamine Hcl 2.jpg')?.id).toBe('g');
    expect(productFolderByFileName(folders, '048_photo of DL-Aspartic Acid with pallet.png')?.id).toBe('a');
    expect(productFolderByFileName(folders, '20251202.jpg')).toBeNull();
    expect(productFolderByFileName(folders, 'acid.jpg')).toBeNull(); // two acids → ambiguous
  });
});
