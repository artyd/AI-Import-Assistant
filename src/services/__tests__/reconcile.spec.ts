import { describe, it, expect } from 'vitest';
import { reconcile, type ReconcileDoc } from '../reconcile.js';

/** Minimal invoice doc builder. */
function inv(fields: Record<string, unknown>, name = 'invoice'): ReconcileDoc {
  return { file_id: name, file_name: name, doc_type: 'invoice', fields };
}

const OUTBOUND = inv(
  { seller: 'PrimeForce Ltd', buyer: 'AGroup95', total_value: 1200, currency: 'USD', net_weight_kg: 100 },
  'outbound',
);
const INBOUND = inv(
  { seller: 'Sujata Chemicals', buyer: 'PrimeForce Ltd', total_value: 1000, currency: 'USD', net_weight_kg: 100 },
  'inbound',
);

const has = (out: ReturnType<typeof reconcile>, field: string) => out.some((d) => d.field === field);

describe('reconcile — contract mode', () => {
  it('bilateral: two invoices are flagged as a duplicate (existing behaviour)', () => {
    const out = reconcile([OUTBOUND, INBOUND]); // no opts ⇒ bilateral
    const dup = out.find((d) => d.field === 'documents' && d.actual.includes('invoice: знайдено 2'));
    expect(dup).toBeTruthy();
    expect(has(out, 'markup')).toBe(false);
    expect(has(out, 'intermediary')).toBe(false);
  });

  it('trilateral: two legs are expected — no duplicate warning, markup surfaced as info', () => {
    const out = reconcile([INBOUND, OUTBOUND], { contractMode: 'trilateral' });
    // Two invoices is normal for a 3-party deal → no "знайдено 2" duplicate note.
    expect(out.some((d) => d.field === 'documents' && d.actual.includes('знайдено 2'))).toBe(false);
    // The value gap between legs is expected markup, not a mismatch.
    const markup = out.find((d) => d.field === 'markup');
    expect(markup?.severity).toBe('info');
    // PrimeForce is the outbound seller / inbound buyer → intermediary confirmed.
    expect(has(out, 'intermediary')).toBe(false);
    // No spurious total_value mismatch between the two legs.
    expect(has(out, 'total_value')).toBe(false);
  });

  it('trilateral: negative markup (inbound > outbound) is a warning', () => {
    const inbound = inv(
      { seller: 'Sujata Chemicals', buyer: 'PrimeForce Ltd', total_value: 1500, currency: 'USD' },
      'inbound-hi',
    );
    const out = reconcile([OUTBOUND, inbound], { contractMode: 'trilateral' });
    const markup = out.find((d) => d.field === 'markup');
    expect(markup?.severity).toBe('warning');
  });

  it('trilateral: physical goods must match across legs (weight mismatch = error)', () => {
    const inbound = inv(
      { seller: 'Sujata Chemicals', buyer: 'PrimeForce Ltd', total_value: 1000, currency: 'USD', net_weight_kg: 80 },
      'inbound-w',
    );
    const out = reconcile([OUTBOUND, inbound], { contractMode: 'trilateral' });
    const w = out.find((d) => d.field === 'net_weight_kg');
    expect(w?.severity).toBe('error');
  });

  it('trilateral: a single invoice yields a leg-presence note', () => {
    const out = reconcile([OUTBOUND], { contractMode: 'trilateral' });
    const note = out.find((d) => d.field === 'documents' && d.actual.includes('лише один інвойс'));
    expect(note).toBeTruthy();
  });

  it('trilateral: intermediary not confirmed → yellow verify note', () => {
    const outbound = inv({ seller: 'Some Trader GmbH', buyer: 'AGroup95', total_value: 1200, currency: 'USD' }, 'ob');
    const inbound = inv({ seller: 'Sujata Chemicals', buyer: 'Some Trader GmbH', total_value: 1000, currency: 'USD' }, 'ib');
    const out = reconcile([outbound, inbound], { contractMode: 'trilateral' });
    const note = out.find((d) => d.field === 'intermediary');
    expect(note?.kind).toBe('suspected');
  });
});
