import { describe, it, expect } from 'vitest';
import { changedFields } from '../contextDerive.js';
import type { WorkspaceRow } from '../workspaceAccess.js';

const ws = {
  incoterm_in: 'FCA',
  incoterm_out: 'CPT',
  transport_mode: 'multimodal',
  origin_country: 'Індія',
  destination_country: null,
} as unknown as WorkspaceRow;

describe('autoContext — manual-edit provenance', () => {
  it('the sidebar Save sends every field; only the ones actually changed are locked', () => {
    expect(
      changedFields(ws, {
        incoterm_in: 'FCA',
        incoterm_out: 'CPT',
        transport_mode: 'air',
        origin_country: 'Індія',
        destination_country: null,
        product_category: 'Субстанція (АФІ)',
      }),
    ).toEqual(['transport_mode']);
  });

  it('clearing a field is a change', () => {
    expect(changedFields(ws, { origin_country: null })).toEqual(['origin_country']);
  });
});
