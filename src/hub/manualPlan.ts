import { STATUS_LABEL_UK, type TrackStatus } from './types.js';

/**
 * Hand-kept track data — what a logist types in the hub, or what the team sheet
 * says for a sea item kept by hand. Only the fields present change; `null`
 * clears a date.
 */
export interface ManualInput {
  status?: TrackStatus;
  statusText?: string;
  origin?: string;
  destination?: string;
  vesselName?: string;
  vesselImo?: string;
  departedAt?: string | null;
  eta?: string | null;
  arrivedAt?: string | null;
}

/** The track fields the plan reads. */
export interface ManualItem {
  status: TrackStatus;
  status_text: string;
  origin: string;
  destination: string;
  vessel_name: string;
  vessel_imo: string;
  departed_at: string | null;
  eta: string | null;
  arrived_at: string | null;
}

/** Who entered the data: the hub form (a person) or the team-sheet sync. */
export type ManualVia = 'hand' | 'sheet';

export interface ManualPlan {
  status: TrackStatus;
  statusText: string;
  origin: string;
  destination: string;
  originChanged: boolean;
  destinationChanged: boolean;
  vesselName: string;
  vesselImo: string;
  /** A new vessel name/IMO re-arms the AIS resolver. */
  vesselChanged: boolean;
  departedAt: string | null;
  eta: string | null;
  arrivedAt: string | null;
  statusChanged: boolean;
  /** Important-only team notifications: dedupe key suffix + text. */
  notifications: { kind: string; text: string }[];
}

const IMPORTANT: TrackStatus[] = ['delivered', 'at_port', 'exception', 'customs', 'out_for_delivery'];
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });

/**
 * One rule set for hand-kept data, whoever enters it (pure; `now` is an ISO time):
 *  - delivered without an arrival time → arrived now;
 *  - a move into "in transit" without a departure → it left now (anchors the
 *    estimated position and the countdown);
 *  - teammates hear about an important status change and, for hub edits, an ETA
 *    shift of a day or more. The sheet sync announces plan changes itself.
 */
export function planManualUpdate(item: ManualItem, m: ManualInput, via: ManualVia, now: string): ManualPlan {
  const pick = <T>(v: T | undefined, old: T): T => (v === undefined ? old : v);
  const origin = pick(m.origin, item.origin).slice(0, 200);
  const destination = pick(m.destination, item.destination).slice(0, 200);
  const vesselName = pick(m.vesselName, item.vessel_name).slice(0, 120);
  const vesselImo = pick(m.vesselImo, item.vessel_imo).slice(0, 20);
  const status = pick(m.status, item.status);
  const eta = pick(m.eta, item.eta);
  let arrivedAt = pick(m.arrivedAt, item.arrived_at);
  if (status === 'delivered' && !arrivedAt) arrivedAt = now;
  let departedAt = pick(m.departedAt, item.departed_at);
  if (status === 'in_transit' && item.status !== 'in_transit' && !departedAt) departedAt = now;

  const suffix = via === 'sheet' ? 'таблиця' : 'внесено вручну';
  const notifications: ManualPlan['notifications'] = [];
  const statusChanged = status !== item.status;
  if (statusChanged && item.status !== 'pending' && IMPORTANT.includes(status)) {
    const where = status !== 'exception' && destination ? ` — ${destination}` : '';
    notifications.push({ kind: status, text: `${STATUS_LABEL_UK[status]}${where} (${suffix}).` });
  }
  if (via === 'hand' && item.eta && eta) {
    const shiftH = (new Date(eta).getTime() - new Date(item.eta).getTime()) / 3_600_000;
    if (Math.abs(shiftH) >= 24) {
      const days = Math.round(shiftH / 24);
      notifications.push({
        kind: 'eta',
        text: `ETA зсунулась на ${days > 0 ? '+' : ''}${days} дн. (тепер ${fmtDate(eta)}, ${suffix}).`,
      });
    }
  }

  return {
    status,
    statusText: pick(m.statusText, item.status_text).slice(0, 300),
    origin,
    destination,
    originChanged: origin !== item.origin,
    destinationChanged: destination !== item.destination,
    vesselName,
    vesselImo,
    vesselChanged: vesselName !== item.vessel_name || vesselImo !== item.vessel_imo,
    departedAt,
    eta,
    arrivedAt,
    statusChanged,
    notifications,
  };
}
