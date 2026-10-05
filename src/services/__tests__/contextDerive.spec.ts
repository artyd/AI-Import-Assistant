import { describe, it, expect } from 'vitest';
import {
  deriveIncoterms,
  deriveOriginCountry,
  deriveTransportMode,
  isUiValue,
  type DeriveDoc,
} from '../contextDerive.js';
import { countryToUk } from '../../domain/countries.js';

const d = (file_name: string, doc_type: string, fields: Record<string, unknown>, markdown?: string): DeriveDoc => ({
  file_name,
  doc_type,
  fields,
  markdown,
});

// Метопрен (2026-10-05 live test): the PTM contract (buyer's side) was indexed
// first and froze origin = Ukraine, incoterm_in = "CPT - Bila Tserkva…".
const PTM = d('03062026PTM.pdf', 'contract', {
  seller: 'PRIME FORCE UK BUSINESS LIMITED',
  buyer: 'TEKHINFORM PLUS LLC',
  incoterm: 'CPT - Bila Tserkva, Ukraine (INCOTERMS 2010)',
});
const NGL_INV = d('INVOICE.pdf', 'invoice', {
  seller: 'NGL Fine-Chem Limited',
  buyer: 'Prime Force UK Business Ltd',
  incoterm: 'FCA BY AIR MUMBAI AIRPORT',
  country_of_origin: 'India',
});
const PRIME_INV = d('Inv PL S-METHOPRENE.pdf', 'invoice', {
  seller: 'PRIME FORCE UK BUSINESS LIMITED',
  buyer: '«TEKHINFORM PLUS» LLC',
  incoterm: 'CPT Bila Tzerkva, Ukraine',
});
const COO = d('COO.pdf', 'certificate_of_origin', { country_of_origin: 'INDIA' });

describe('contextDerive — Метопрен', () => {
  it('origin is the goods origin from COO/invoice, never the buyer country', () => {
    expect(deriveOriginCountry([PTM, NGL_INV, PRIME_INV, COO], 'Ukraine')).toBe('Індія');
  });

  it('origin falls back to the sender country when no document states it', () => {
    expect(deriveOriginCountry([PTM], 'Індія/India')).toBe('Індія');
  });

  it('trilateral Incoterms: inbound = intermediary buys (FCA), outbound = intermediary sells (CPT)', () => {
    expect(deriveIncoterms([PTM, NGL_INV, PRIME_INV], 'trilateral', 'PRIME FORCE UK BUSINESS LIMITED')).toEqual({
      incoterm_in: 'FCA',
      incoterm_out: 'CPT',
    });
  });

  it('trilateral with only the outbound contract indexed yet: in unknown, out CPT', () => {
    expect(deriveIncoterms([PTM], 'trilateral', 'Prime Force UK')).toEqual({ incoterm_in: null, incoterm_out: 'CPT' });
  });

  it('bilateral: one leg, invoice outranks contract, code only', () => {
    const c = d('c.pdf', 'contract', { incoterm: 'DAP Kyiv' });
    const i = d('i.pdf', 'invoice', { incoterm: 'CIP Kyiv Airport (Incoterms 2020)' });
    expect(deriveIncoterms([c, i], 'bilateral', null)).toEqual({ incoterm_in: 'CIP', incoterm_out: null });
  });

  it('transport: AWB + CMR = multimodal; Нова Пошта last-mile ignored', () => {
    const docs = [
      d('AIRWAY BILL.PDF', 'transport', {}, 'HOUSE AIR WAYBILL ... Airport of Departure MUMBAI'),
      d('CMR - SAID0009199.pdf', 'transport', {}, 'CMR Міжнародна товарно-транспортна накладна'),
      d('IMG_7217.jpeg', 'transport', {}, 'Нова Пошта експрес-накладна 20400540693174'),
    ];
    expect(deriveTransportMode(docs)).toBe('multimodal');
    expect(deriveTransportMode(docs.slice(0, 1))).toBe('air');
    expect(deriveTransportMode(docs.slice(2))).toBeNull();
  });

  it('values the sidebar could not have produced are recognised as legacy autopilot output', () => {
    expect(isUiValue('incoterm_in', 'CPT - BILA TSERKVA, UKRAINE (INCOTERMS 2010)')).toBe(false);
    expect(isUiValue('incoterm_in', 'FCA')).toBe(true);
    expect(isUiValue('origin_country', 'Ukraine')).toBe(false);
    expect(isUiValue('origin_country', 'Індія')).toBe(true);
    expect(isUiValue('transport_mode', 'multimodal')).toBe(true);
  });

  it('countryToUk resolves document spellings', () => {
    expect(countryToUk('Індія/India')).toBe('Індія');
    expect(countryToUk('UK')).toBe('Велика Британія');
    expect(countryToUk('United Kingdom')).toBe('Велика Британія');
    expect(countryToUk('IN')).toBe('Індія');
    expect(countryToUk('Atlantis')).toBeNull();
  });
});

describe('contextDerive — review follow-ups', () => {
  it('a CMR that cites the AWB number is still road (earliest match decides)', () => {
    const cmr = d('CMR - SAID0009199.pdf', 'transport', {}, 'CMR consignment note ... ref. AWB 098-31298724');
    expect(deriveTransportMode([cmr])).toBe('road');
  });
});
