import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../db/pool.js', () => ({ query: vi.fn() }));
vi.mock('../../../config.js', () => ({ config: { LOGIST_MCP_URL: '' } }));

// Contract 01102026/PJH: the seller's legal address is in Singapore, but clause
// 4.2 makes it the consignor with a Tianjin address — the letter must use 4.2.
const contract = {
  file_name: '01102026PJH.docx',
  doc_type: 'contract',
  fields: {
    consignor_name: 'Jinyao Pharmaceuticals (Singapore) PTE. LTD.',
    consignor_address:
      'No. 19, Xin Ye 9th Street, West Area of Tianjin Economic-Technological Development Area, Tianjin 300462, China',
    consignee_name: 'TEKHINFORM PLUS LLC',
    consignee_address: 'Ukraine, 61001, Kharkiv, 14-A, Frankivska street',
    parties: [
      { name: 'Jinyao Pharmaceuticals (Singapore) PTE. LTD.', role: 'Seller / Consignor', address: '78 Shenton Way, #19-02, Singapore (079120)' },
    ],
  },
};

describe('contractParty — consignor/consignee from the shipment clause', () => {
  it('prefers the dedicated consignor fields over the seller\'s legal address', async () => {
    const { contractParty } = await import('../prefill.js');
    const p = contractParty(contract, 'consignor');
    expect(p?.address).toMatch(/Tianjin 300462, China$/);
    expect(p?.country).toBe('China');
  });

  it('reads the consignee country from the start of the address, never a street', async () => {
    const { countryInAddress } = await import('../prefill.js');
    expect(countryInAddress('Ukraine, 61001, Kharkiv, 14-A, Frankivska street')).toBe('Ukraine');
    expect(countryInAddress('61001, Kharkiv, 14-A, Frankivska street')).toBe('');
    expect(countryInAddress('No. 19, Xin Ye 9th Street, Tianjin 300462, China')).toBe('China');
  });
});
