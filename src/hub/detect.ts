import {
  carrierByAwbPrefix,
  carrierByBlPrefix,
  carrierByContainerPrefix,
  getCarrier,
  type HubMode,
} from './carriers.js';

/**
 * Tracking-number recognition. Given whatever a logist pastes (a container
 * number, a B/L, an AWB, a courier waybill, a Нова Пошта ТТН…) returns ranked
 * candidates `{ carrier, kind, mode }`. Validation is strict where the format has
 * a check digit (ISO 6346 containers, IATA AWB mod-7) so the document scanner can
 * use the same function without flooding the logist with false positives.
 *
 * Pure — no I/O. Unit-tested in __tests__/detect.spec.ts.
 */

export type NumberKind = 'container' | 'bl' | 'awb' | 'parcel';

export interface DetectCandidate {
  carrier: string;
  kind: NumberKind;
  mode: HubMode;
  /** 0..1 — 1 = check digit verified / unambiguous format. */
  confidence: number;
}

export interface DetectResult {
  /** Upper-cased, separators stripped (AWB keeps 11 digits, no dash). */
  normalized: string;
  candidates: DetectCandidate[];
}

/** Uppercase and strip spaces / dashes / dots / slashes. */
export function normalizeNumber(raw: string): string {
  return raw.toUpperCase().replace(/[\s\-./]/g, '');
}

// ISO 6346 letter values: A=10 … Z=38, skipping multiples of 11 (11, 22, 33).
const LETTER_VALUES: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  let v = 10;
  for (let i = 0; i < 26; i += 1) {
    if (v % 11 === 0) v += 1;
    out[String.fromCharCode(65 + i)] = v;
    v += 1;
  }
  return out;
})();

/** True when `n` is a well-formed ISO 6346 container number with a valid check digit. */
export function isValidContainer(n: string): boolean {
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(n)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const ch = n[i]!;
    const val = i < 4 ? LETTER_VALUES[ch]! : Number(ch);
    sum += val * 2 ** i;
  }
  return (sum % 11) % 10 === Number(n[10]);
}

/** True when `n` is 11 digits whose serial passes the IATA mod-7 check. */
export function isValidAwb(n: string): boolean {
  if (!/^\d{11}$/.test(n)) return false;
  const serial = n.slice(3, 10);
  return Number(serial) % 7 === Number(n[10]);
}

function cand(carrier: string, kind: NumberKind, confidence: number): DetectCandidate {
  return { carrier, kind, mode: getCarrier(carrier)?.mode ?? 'courier', confidence };
}

export function detectNumber(raw: string): DetectResult {
  const n = normalizeNumber(raw);
  const out: DetectCandidate[] = [];

  // Container (ISO 6346).
  if (/^[A-Z]{3}[UJZ]\d{7}$/.test(n)) {
    const valid = isValidContainer(n);
    const carrier = carrierByContainerPrefix(n.slice(0, 4));
    out.push(cand(carrier?.id ?? 'sea-generic', 'container', valid ? (carrier ? 1 : 0.8) : 0.4));
  }

  // UPS 1Z…
  if (/^1Z[0-9A-Z]{16}$/.test(n)) out.push(cand('ups', 'parcel', 1));

  // UPU S10 international postal item: 2 letters, 9 digits, 2-letter country.
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(n)) {
    out.push(cand(n.endsWith('UA') ? 'ukrposhta' : 'upu', 'parcel', 0.9));
  }

  // DHL eCommerce / parcel JJD…
  if (/^J?JD\d{16,20}$/.test(n)) out.push(cand('dhl', 'parcel', 0.9));

  // B/L: a known carrier prefix followed by 6+ alphanumerics (not a container).
  if (out.length === 0 && /^[A-Z]{4}[A-Z0-9]{6,14}$/.test(n)) {
    const carrier = carrierByBlPrefix(n.slice(0, 4));
    if (carrier) out.push(cand(carrier.id, 'bl', 0.85));
  }

  if (/^\d+$/.test(n)) {
    // AWB: 11 digits = 3-digit airline prefix + 8-digit serial (mod-7 check).
    if (n.length === 11) {
      const valid = isValidAwb(n);
      const airline = carrierByAwbPrefix(n.slice(0, 3));
      if (valid) out.push(cand(airline?.id ?? 'air-generic', 'awb', airline ? 1 : 0.7));
      else if (airline) out.push(cand(airline.id, 'awb', 0.4));
    }
    // Нова Пошта ТТН: 14 digits (starts 1/2/5 in practice).
    if (n.length === 14) out.push(cand('novaposhta', 'parcel', /^[125]/.test(n) ? 0.95 : 0.6));
    // Укрпошта barcode: 13 digits.
    if (n.length === 13) out.push(cand('ukrposhta', 'parcel', 0.8));
    // DHL Express waybill: 10 digits.
    if (n.length === 10) out.push(cand('dhl', 'parcel', 0.8));
    // FedEx: 12 / 15 / 20 / 22 digits.
    if ([12, 15, 20, 22].includes(n.length)) out.push(cand('fedex', 'parcel', n.length === 12 ? 0.8 : 0.6));
    // TNT consignment: 9 digits.
    if (n.length === 9) out.push(cand('tnt', 'parcel', 0.5));
  }

  out.sort((a, b) => b.confidence - a.confidence);
  return { normalized: n, candidates: out };
}

/** Best guess or null. */
export function bestCandidate(raw: string): DetectCandidate | null {
  return detectNumber(raw).candidates[0] ?? null;
}

/**
 * Scan free text (a document's Markdown) for trackable numbers. Only HIGH-
 * confidence hits are returned — check-digit-valid containers and AWBs, and B/L
 * numbers with a known carrier prefix — so suggestions are never noise.
 */
export type ScannedNumber = DetectCandidate & { number: string };

export function scanTrackingNumbers(text: string): ScannedNumber[] {
  const found = new Map<string, ScannedNumber>();
  const add = (number: string, c: DetectCandidate | undefined) => {
    if (!c || found.has(number)) return;
    found.set(number, { ...c, number });
  };

  const up = text.toUpperCase();
  // Containers: allow "MSKU 123456-7" / "MSKU1234567".
  for (const m of up.matchAll(/\b([A-Z]{3}[UJZ])\s?(\d{6})\s?-?\s?(\d)\b/g)) {
    const n = `${m[1]}${m[2]}${m[3]}`;
    if (isValidContainer(n)) add(n, detectNumber(n).candidates[0]);
  }
  // AWB: "157-12345675" or "157 1234 5675" near an AWB keyword is the common form;
  // require the dash/space form or a nearby AWB keyword to avoid random 11-digit ids.
  for (const m of up.matchAll(/\b(\d{3})[-\s](\d{4})\s?(\d{4})\b/g)) {
    const n = `${m[1]}${m[2]}${m[3]}`;
    if (isValidAwb(n) && carrierByAwbPrefix(n.slice(0, 3))) add(n, detectNumber(n).candidates[0]);
  }
  // B/L with known carrier prefixes, near a B/L keyword.
  for (const m of up.matchAll(/(?:B\/L|\bBL|BILL OF LADING|КОНОСАМЕНТ)\s*(?:NO\.?|NUMBER|№|#)?[^A-Z0-9]{0,20}([A-Z]{4}[A-Z0-9]{6,14})\b/g)) {
    const n = m[1]!;
    const c = detectNumber(n).candidates.find((x) => x.kind === 'bl');
    add(n, c);
  }
  return [...found.values()];
}
