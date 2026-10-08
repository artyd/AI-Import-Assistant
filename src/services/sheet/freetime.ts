import { config } from '../../config.js';
import type { TrackingRow } from './parse.js';

/**
 * Free time at the destination port (before demurrage / storage charges):
 * starts when the container arrives (the date in the status text, else the
 * planned arrival) and lasts N days — the sheet's own «Free time» column if
 * present, else the line's default (SHEET_FREE_DAYS_BY_LINE, e.g. "MSC:10"),
 * else SHEET_FREE_DAYS. Sea cargo only; ends once cleared / delivered.
 */

export interface FreeTime {
  start: string;
  end: string;
  days: number;
  source: 'sheet' | 'line' | 'default';
  /** true when counted from the actual arrival, false from the plan. */
  fromActual: boolean;
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** "MSC:10, MAERSK:7" → { MSC: 10, MAERSK: 7 } (keys upper-cased). */
export function parseLineDays(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of raw.split(/[,;]/)) {
    const m = part.trim().match(/^(.+?)\s*[:=]\s*(\d{1,3})$/);
    if (m) out[m[1]!.trim().toUpperCase()] = Number(m[2]);
  }
  return out;
}

const SEA_TYPES = new Set(['fcl', 'groupage', 'lcl']);

export function freeTimeOf(
  r: Pick<TrackingRow, 'mode' | 'cargoType' | 'status' | 'statusDate' | 'arrival' | 'freeDays' | 'line' | 'carrier'>,
  defaults = { days: config.SHEET_FREE_DAYS, byLine: parseLineDays(config.SHEET_FREE_DAYS_BY_LINE) },
): FreeTime | null {
  if (r.mode !== 'sea' && !SEA_TYPES.has(r.cargoType)) return null;
  if (r.status === 'customs' || r.status === 'delivered') return null;
  const actual = r.status === 'arrived' && r.statusDate ? r.statusDate.date : null;
  const start = actual ?? r.arrival?.date ?? null;
  if (!start) return null;
  const lineKey = [r.line, r.carrier].map((x) => (x ?? '').toUpperCase()).find((k) => k && defaults.byLine[k] != null);
  const [days, source]: [number, FreeTime['source']] =
    r.freeDays != null ? [r.freeDays, 'sheet'] : lineKey ? [defaults.byLine[lineKey]!, 'line'] : [defaults.days, 'default'];
  return { start, end: addDays(start, days), days, source, fromActual: !!actual };
}
