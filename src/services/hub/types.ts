/** Shared types for the logistics hub tracking pipeline. */

export type TrackStatus =
  | 'pending' // added, never checked
  | 'info' // carrier knows the number, cargo not moving yet (booking / label created)
  | 'in_transit'
  | 'at_port' // arrived at a port / airport / hub (transshipment or destination)
  | 'customs'
  | 'out_for_delivery' // at the destination branch / on the last mile
  | 'delivered'
  | 'exception' // returned, refused, held, lost
  | 'unknown'; // no data from any source

export const TRACK_STATUSES: readonly TrackStatus[] = [
  'pending',
  'info',
  'in_transit',
  'at_port',
  'customs',
  'out_for_delivery',
  'delivered',
  'exception',
  'unknown',
];

export const STATUS_LABEL_UK: Record<TrackStatus, string> = {
  pending: 'Очікує перевірки',
  info: 'Дані отримано, ще не відправлено',
  in_transit: 'В дорозі',
  at_port: 'У порту / хабі',
  customs: 'Митне оформлення',
  out_for_delivery: 'Доставка / у відділенні',
  delivered: 'Доставлено',
  exception: 'Проблема',
  unknown: 'Немає даних',
};

export interface TrackEventIn {
  /** ISO timestamp or null when the source gives none. */
  at: string | null;
  location: string;
  description: string;
  /** Planned / estimated (not yet happened). */
  planned?: boolean;
}

export interface TrackResult {
  /** True when the source recognised the number and returned data. */
  found: boolean;
  status: TrackStatus;
  statusText: string;
  events: TrackEventIn[];
  origin?: string;
  destination?: string;
  vesselName?: string;
  vesselImo?: string;
  eta?: string | null;
  departedAt?: string | null;
  arrivedAt?: string | null;
  /** 'api:novaposhta' | 'scrape:maersk' | … */
  source: string;
  /** Hash of the scraped page text (skip re-parsing an unchanged page). */
  pageHash?: string;
  /** Set when the source was reachable but returned no usable data. */
  note?: string;
}

/** Normalise any date-ish string to ISO, or null. */
export function toIso(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  // dd.mm.yyyy[ hh:mm[:ss]]
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
