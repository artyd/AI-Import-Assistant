import { createHash } from 'node:crypto';
import { query } from '../../db/pool.js';
import { insertNotification } from '../notifications.js';
import { config } from '../../config.js';
import { track17, trackDhl, trackMaersk, trackNovaPoshta, trackUkrposhta } from './apiSources.js';
import { getCarrier, trackingUrl, type HubMode } from './carriers.js';
import { detectNumber, normalizeNumber, type NumberKind } from './detect.js';
import { geocode } from './geocode.js';
import { scrapeTracking } from './scrape.js';
import { sheetRowUrl } from '../sheet/link.js';
import { STATUS_LABEL_UK, type TrackEventIn, type TrackResult, type TrackStatus } from './types.js';

/**
 * Tracking orchestrator for the logistics hub.
 *
 *   lookupNumber()   detect carrier → official API → carrier page (logist-mcp /
 *                    Chromium + Claude) — the hybrid source chain. Read-only;
 *                    used by the public MCP tool and by refresh.
 *   addTracked()     persist a number for a user (optionally linked to a
 *                    shipment) and check it immediately.
 *   refreshTracked() re-check one item, store new events, geocode, and raise an
 *                    in-app notification only for what matters: arrival,
 *                    delivery, a problem, or an ETA shift ≥ 24h.
 *   refreshDue()     the worker cron's batch.
 */

export interface TrackedRow {
  id: string;
  owner_id: string;
  workspace_id: string | null;
  number: string;
  kind: NumberKind;
  carrier: string;
  mode: HubMode;
  label: string;
  status: TrackStatus;
  status_text: string;
  origin: string;
  destination: string;
  origin_lat: number | null;
  origin_lng: number | null;
  dest_lat: number | null;
  dest_lng: number | null;
  vessel_name: string;
  vessel_imo: string;
  vessel_mmsi: string;
  departed_at: string | null;
  eta: string | null;
  first_eta: string | null;
  arrived_at: string | null;
  source: string;
  page_hash: string;
  last_checked_at: string | null;
  last_changed_at: string | null;
  last_error: string;
  archived: boolean;
  created_at: string;
  /** Synced from the team Google Sheet → visible to everyone. */
  team?: boolean;
  workspace_number?: string | null;
  sheet_row_index?: number | null;
}

export interface TrackingEventRow {
  id: string;
  at: string | null;
  location: string;
  lat: number | null;
  lng: number | null;
  description: string;
  planned: boolean;
  manual: boolean;
}

/** API shape (camelCase) — see API_CONTRACT.md "Logistics hub". */
export function serializeTracked(r: TrackedRow) {
  return {
    id: r.id,
    number: r.number,
    kind: r.kind,
    carrier: r.carrier,
    carrierName: getCarrier(r.carrier)?.name ?? r.carrier,
    mode: r.mode,
    label: r.label,
    status: r.status,
    statusLabel:
      r.status === 'pending' && isManualSea(r.mode, r.carrier)
        ? 'Чекає даних від логіста'
        : (STATUS_LABEL_UK[r.status] ?? r.status),
    statusText: r.status_text,
    origin: r.origin,
    destination: r.destination,
    originPos: r.origin_lat != null && r.origin_lng != null ? [r.origin_lat, r.origin_lng] : null,
    destPos: r.dest_lat != null && r.dest_lng != null ? [r.dest_lat, r.dest_lng] : null,
    vesselName: r.vessel_name,
    vesselImo: r.vessel_imo,
    departedAt: r.departed_at,
    eta: r.eta,
    firstEta: r.first_eta,
    arrivedAt: r.arrived_at,
    source: r.source,
    lastCheckedAt: r.last_checked_at,
    lastChangedAt: r.last_changed_at,
    lastError: r.last_error,
    workspaceId: r.workspace_id,
    workspaceNumber: r.workspace_number ?? null,
    trackUrl: trackingUrl(r.carrier, r.number),
    manualOnly: isManualSea(r.mode, r.carrier),
    team: !!r.team,
    /** Row of the team sheet this item comes from (plan fields are read-only here). */
    sheet: r.sheet_row_index ? { rowIndex: r.sheet_row_index, url: sheetRowUrl('tracking', r.sheet_row_index) } : null,
    createdAt: r.created_at,
  };
}

export type TrackedDto = ReturnType<typeof serializeTracked>;

// ── Source chain ─────────────────────────────────────────────────────────────

async function apiFor(number: string, carrier: string, kind: NumberKind): Promise<TrackResult | null> {
  switch (carrier) {
    case 'novaposhta':
      return trackNovaPoshta(number);
    case 'ukrposhta':
      return firstFound(() => trackUkrposhta(number), () => track17(number));
    case 'dhl':
      return firstFound(() => trackDhl(number), () => track17(number));
    case 'fedex':
    case 'ups':
    case 'tnt':
    case 'upu':
    case 'meest':
      return track17(number);
    case 'maersk':
      return kind === 'container' || kind === 'bl' ? trackMaersk(number, kind) : null;
    default:
      return null;
  }
}

/** First adapter that recognised the number; else the last non-null answer. */
async function firstFound(...fns: Array<() => Promise<TrackResult | null>>): Promise<TrackResult | null> {
  let last: TrackResult | null = null;
  for (const fn of fns) {
    const r = await fn();
    if (r?.found) return r;
    if (r) last = r;
  }
  return last;
}

/**
 * Sea in manual mode: logists keep the data up to date by hand. Only an official
 * carrier API (when its key is configured) may still update such an item.
 */
export function isManualSea(mode: string, carrier: string): boolean {
  if (mode !== 'sea' || config.TRACKING_SEA_MODE !== 'manual') return false;
  return !(carrier === 'maersk' && config.MAERSK_API_KEY);
}

const MANUAL_NOTE = 'Морські перевезення ведуться вручну — дані вносить логіст.';

/** Run the hybrid chain. Never throws — transport errors land in `note`. */
export async function runSources(
  number: string,
  carrier: string,
  kind: NumberKind,
  prevHash = '',
): Promise<TrackResult> {
  const notes: string[] = [];
  const mode = getCarrier(carrier)?.mode ?? '';
  if (isManualSea(mode, carrier)) {
    return { found: false, status: 'unknown', statusText: '', events: [], source: 'manual', note: MANUAL_NOTE };
  }
  try {
    const api = await apiFor(number, carrier, kind);
    if (api?.found) return api;
    if (api) notes.push(`${api.source}: номер не знайдено`);
  } catch (err) {
    notes.push(`API: ${(err as Error).message}`);
  }
  if (mode === 'sea' && config.TRACKING_SEA_MODE === 'manual') {
    return { found: false, status: 'unknown', statusText: '', events: [], source: 'none', note: notes.join(' · ') };
  }
  try {
    const scraped = await scrapeTracking(number, carrier, prevHash);
    if (scraped) {
      if (scraped.found) return scraped;
      if (scraped.note) notes.push(scraped.note);
    }
  } catch (err) {
    notes.push(`Сторінка перевізника: ${(err as Error).message}`);
  }
  return { found: false, status: 'unknown', statusText: '', events: [], source: 'none', note: notes.join(' · ') };
}

export interface LookupOutcome {
  number: string;
  carrier: string;
  carrierName: string;
  kind: NumberKind;
  mode: HubMode;
  trackUrl: string | null;
  result: TrackResult;
}

/** Detect + check a number without storing anything (public MCP / preview). */
export async function lookupNumber(raw: string, carrierHint?: string): Promise<LookupOutcome | null> {
  const det = detectNumber(raw);
  const best = carrierHint
    ? (det.candidates.find((c) => c.carrier === carrierHint) ?? {
        carrier: carrierHint,
        kind: det.candidates[0]?.kind ?? 'parcel',
        mode: getCarrier(carrierHint)?.mode ?? 'courier',
        confidence: 0.5,
      })
    : det.candidates[0];
  if (!best || !getCarrier(best.carrier)) return null;
  const result = await runSources(det.normalized, best.carrier, best.kind);
  return {
    number: det.normalized,
    carrier: best.carrier,
    carrierName: getCarrier(best.carrier)?.name ?? best.carrier,
    kind: best.kind,
    mode: best.mode,
    trackUrl: trackingUrl(best.carrier, det.normalized),
    result,
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

const SELECT = `SELECT t.*, w.number AS workspace_number, sr.row_index AS sheet_row_index
  FROM tracked_items t LEFT JOIN workspaces w ON w.id = t.workspace_id
  LEFT JOIN LATERAL (
    SELECT row_index FROM sheet_rows s WHERE s.tracked_id = t.id AND NOT s.removed ORDER BY s.updated_at DESC LIMIT 1
  ) sr ON TRUE`;

/** Items the user can see: team items (from the sheet), their own, and any linked to a shipment they own. */
const VISIBLE = `(t.team OR t.owner_id = $1 OR t.workspace_id IN (SELECT id FROM workspaces WHERE owner_id = $1))`;

export async function listTracked(
  userId: string,
  opts: { workspaceId?: string; includeArchived?: boolean } = {},
): Promise<TrackedRow[]> {
  const params: unknown[] = [userId];
  let where = VISIBLE;
  if (opts.workspaceId) {
    params.push(opts.workspaceId);
    where += ` AND t.workspace_id = $${params.length}`;
  }
  if (!opts.includeArchived) where += ' AND NOT t.archived';
  const { rows } = await query<TrackedRow>(`${SELECT} WHERE ${where} ORDER BY t.created_at DESC LIMIT 500`, params);
  return rows;
}

export async function getTracked(userId: string, id: string): Promise<TrackedRow | null> {
  const { rows } = await query<TrackedRow>(`${SELECT} WHERE t.id = $2 AND ${VISIBLE}`, [userId, id]);
  return rows[0] ?? null;
}

export async function listEvents(trackedId: string): Promise<TrackingEventRow[]> {
  const { rows } = await query<TrackingEventRow>(
    `SELECT id, at, location, lat, lng, description, planned, manual FROM tracking_events
     WHERE tracked_id = $1 ORDER BY at NULLS LAST, created_at`,
    [trackedId],
  );
  return rows;
}

export class HubError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function addTracked(
  ownerId: string,
  input: { number: string; carrier?: string; label?: string; workspaceId?: string | null },
): Promise<TrackedRow> {
  const det = detectNumber(input.number);
  if (det.normalized.length < 6 || det.normalized.length > 40 || !/^[A-Z0-9]+$/.test(det.normalized)) {
    throw new HubError('Некоректний номер для відстеження.');
  }
  let cand = input.carrier ? det.candidates.find((c) => c.carrier === input.carrier) : det.candidates[0];
  if (!cand && input.carrier) {
    const c = getCarrier(input.carrier);
    if (!c) throw new HubError('Невідомий перевізник.');
    const kind: NumberKind =
      c.mode === 'air' ? 'awb' : c.mode === 'sea' ? (/^[A-Z]{3}[UJZ]\d{7}$/.test(det.normalized) ? 'container' : 'bl') : 'parcel';
    cand = { carrier: c.id, kind, mode: c.mode, confidence: 0.5 };
  }
  if (!cand) {
    throw new HubError('Не вдалося визначити перевізника за номером — оберіть його вручну.', 422);
  }
  const { rows } = await query<{ id: string }>(
    `INSERT INTO tracked_items (owner_id, workspace_id, number, kind, carrier, mode, label)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner_id, number) DO UPDATE SET
       workspace_id = COALESCE(EXCLUDED.workspace_id, tracked_items.workspace_id),
       label = CASE WHEN EXCLUDED.label <> '' THEN EXCLUDED.label ELSE tracked_items.label END,
       carrier = EXCLUDED.carrier, kind = EXCLUDED.kind, mode = EXCLUDED.mode,
       archived = FALSE
     RETURNING id`,
    [ownerId, input.workspaceId ?? null, det.normalized, cand.kind, cand.carrier, cand.mode, (input.label ?? '').slice(0, 120)],
  );
  const id = rows[0]!.id;
  await refreshTracked(id);
  return (await getTracked(ownerId, id))!;
}

function eventHash(e: TrackEventIn): string {
  return createHash('sha256')
    .update(`${e.at ?? ''}|${e.location}|${e.description}|${e.planned ? 1 : 0}`)
    .digest('hex')
    .slice(0, 24);
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });

async function notify(item: TrackedRow, kindKey: string, text: string, exceptUserId?: string): Promise<void> {
  const who = new Set<string>([item.owner_id]);
  if (item.workspace_id) {
    const { rows } = await query<{ owner_id: string }>('SELECT owner_id FROM workspaces WHERE id = $1', [item.workspace_id]);
    if (rows[0]) who.add(rows[0].owner_id);
  }
  if (exceptUserId) who.delete(exceptUserId);
  const name = item.label ? `${item.label} (${item.number})` : item.number;
  for (const uid of who) {
    await insertNotification(uid, item.workspace_id, `hub:${item.id}:${kindKey}`, `🧭 ${name}: ${text}`);
  }
}

/** Re-check one item through the source chain and persist what changed. */
export async function refreshTracked(id: string): Promise<void> {
  const { rows } = await query<TrackedRow>('SELECT * FROM tracked_items WHERE id = $1', [id]);
  const item = rows[0];
  if (!item) return;
  // Kept by hand: nothing to fetch. `source` turns 'manual' once a logist enters data.
  if (isManualSea(item.mode, item.carrier)) return;

  let r: TrackResult;
  try {
    r = await runSources(item.number, item.carrier, item.kind, item.page_hash);
  } catch (err) {
    await query('UPDATE tracked_items SET last_checked_at = now(), last_error = $2 WHERE id = $1', [
      id,
      (err as Error).message.slice(0, 300),
    ]);
    return;
  }

  // Scraped page identical to last time → nothing to re-parse.
  if (r.note === 'unchanged') {
    await query(`UPDATE tracked_items SET last_checked_at = now(), last_error = '' WHERE id = $1`, [id]);
    return;
  }
  if (!r.found) {
    // Keep the last known good data; only mark "no data" if we never had any.
    await query(
      `UPDATE tracked_items SET last_checked_at = now(), last_error = $2,
         status = CASE WHEN status = 'pending' THEN 'unknown' ELSE status END
       WHERE id = $1`,
      [id, (r.note ?? '').slice(0, 300)],
    );
    return;
  }

  // Events (dedup by hash) — geocode new ones offline-first.
  for (const e of r.events) {
    if (!e.description) continue;
    const pos = await geocode(e.location, item.mode === 'air' ? 'air' : item.mode === 'sea' ? 'sea' : undefined);
    await query(
      `INSERT INTO tracking_events (tracked_id, at, location, lat, lng, description, planned, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tracked_id, hash) DO NOTHING`,
      [id, e.at, e.location.slice(0, 200), pos?.[0] ?? null, pos?.[1] ?? null, e.description.slice(0, 500), !!e.planned, eventHash(e)],
    );
  }

  const prefer = item.mode === 'air' ? 'air' : item.mode === 'sea' ? 'sea' : undefined;
  const origin = r.origin || item.origin;
  const destination = r.destination || item.destination;
  const oPos = origin && origin !== item.origin ? await geocode(origin, prefer) : null;
  const dPos = destination && destination !== item.destination ? await geocode(destination, prefer) : null;

  const statusChanged = r.status !== item.status;
  const eta = r.eta ?? item.eta;
  await query(
    `UPDATE tracked_items SET
       status = $2, status_text = $3, origin = $4, destination = $5,
       origin_lat = COALESCE($6, origin_lat), origin_lng = COALESCE($7, origin_lng),
       dest_lat = COALESCE($8, dest_lat), dest_lng = COALESCE($9, dest_lng),
       vessel_name = CASE WHEN $10 <> '' THEN $10 ELSE vessel_name END,
       vessel_imo = CASE WHEN $11 <> '' THEN $11 ELSE vessel_imo END,
       departed_at = COALESCE($12, departed_at), eta = $13,
       first_eta = COALESCE(first_eta, $13), arrived_at = COALESCE($14, arrived_at),
       source = $15, page_hash = $16, last_checked_at = now(), last_error = '',
       last_changed_at = CASE WHEN $17 THEN now() ELSE last_changed_at END
     WHERE id = $1`,
    [
      id,
      r.status,
      r.statusText.slice(0, 300),
      origin.slice(0, 200),
      destination.slice(0, 200),
      oPos?.[0] ?? null,
      oPos?.[1] ?? null,
      dPos?.[0] ?? null,
      dPos?.[1] ?? null,
      r.vesselName ?? '',
      r.vesselImo ?? '',
      r.departedAt ?? null,
      eta,
      r.arrivedAt ?? null,
      r.source,
      r.pageHash ?? '',
      statusChanged,
    ],
  );

  // Important-only notifications (the first check after adding never notifies).
  if (item.status === 'pending') return;
  if (statusChanged && ['delivered', 'at_port', 'exception', 'customs', 'out_for_delivery'].includes(r.status)) {
    const where = r.events.filter((e) => !e.planned).at(-1)?.location;
    await notify(item, r.status, `${STATUS_LABEL_UK[r.status]}${where ? ` — ${where}` : ''}.`);
  }
  if (item.eta && r.eta) {
    const shiftH = (new Date(r.eta).getTime() - new Date(item.eta).getTime()) / 3_600_000;
    if (Math.abs(shiftH) >= 24) {
      const days = Math.round(shiftH / 24);
      await notify(item, 'eta', `ETA зсунулась на ${days > 0 ? '+' : ''}${days} дн. (тепер ${fmtDate(r.eta)}).`);
    }
  }
}

// ── Manual data (sea in TRACKING_SEA_MODE=manual, or a correction by hand) ──

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

const IMPORTANT: TrackStatus[] = ['delivered', 'at_port', 'exception', 'customs', 'out_for_delivery'];

/**
 * Apply what a logist typed in; only the fields present change. Origin /
 * destination are geocoded for the map; a new vessel name/IMO re-arms the AIS
 * resolver (vessel_mmsi reset) so the vessel shows up live. Teammates — not the
 * editor — get the same important-only notifications as for carrier updates.
 */
export async function updateManual(actorId: string, item: TrackedRow, m: ManualInput): Promise<void> {
  const pick = <T>(v: T | undefined, old: T): T => (v === undefined ? old : v);
  const prefer = item.mode === 'air' ? 'air' : item.mode === 'sea' ? 'sea' : undefined;
  const origin = pick(m.origin, item.origin);
  const destination = pick(m.destination, item.destination);
  const oPos = origin !== item.origin ? (origin ? await geocode(origin, prefer) : null) : undefined;
  const dPos = destination !== item.destination ? (destination ? await geocode(destination, prefer) : null) : undefined;
  const vesselName = pick(m.vesselName, item.vessel_name);
  const vesselImo = pick(m.vesselImo, item.vessel_imo);
  const status = pick(m.status, item.status);
  const eta = pick(m.eta, item.eta);
  let arrivedAt = pick(m.arrivedAt, item.arrived_at);
  if (status === 'delivered' && !arrivedAt) arrivedAt = new Date().toISOString();
  // Marked "in transit" without a departure date → it left now (editable in the form);
  // this anchors the estimated position and the countdown.
  let departedAt = pick(m.departedAt, item.departed_at);
  if (status === 'in_transit' && item.status !== 'in_transit' && !departedAt) departedAt = new Date().toISOString();

  await query(
    `UPDATE tracked_items SET
       status = $2, status_text = $3, origin = $4, destination = $5,
       origin_lat = CASE WHEN $6 THEN $7 ELSE origin_lat END,
       origin_lng = CASE WHEN $6 THEN $8 ELSE origin_lng END,
       dest_lat = CASE WHEN $9 THEN $10 ELSE dest_lat END,
       dest_lng = CASE WHEN $9 THEN $11 ELSE dest_lng END,
       vessel_name = $12, vessel_imo = $13,
       vessel_mmsi = CASE WHEN $14 THEN '' ELSE vessel_mmsi END,
       departed_at = $15, eta = $16, first_eta = COALESCE(first_eta, $16), arrived_at = $17,
       source = 'manual', last_error = '', last_checked_at = now(), last_changed_at = now()
     WHERE id = $1`,
    [
      item.id,
      status,
      pick(m.statusText, item.status_text).slice(0, 300),
      origin.slice(0, 200),
      destination.slice(0, 200),
      oPos !== undefined,
      oPos?.[0] ?? null,
      oPos?.[1] ?? null,
      dPos !== undefined,
      dPos?.[0] ?? null,
      dPos?.[1] ?? null,
      vesselName.slice(0, 120),
      vesselImo.slice(0, 20),
      vesselName !== item.vessel_name || vesselImo !== item.vessel_imo,
      departedAt,
      eta,
      arrivedAt,
    ],
  );

  if (status !== item.status && item.status !== 'pending' && IMPORTANT.includes(status)) {
    const where = status !== 'exception' && destination ? ` — ${destination}` : '';
    await notify(item, status, `${STATUS_LABEL_UK[status]}${where} (внесено вручну).`, actorId);
  }
  if (item.eta && eta) {
    const shiftH = (new Date(eta).getTime() - new Date(item.eta).getTime()) / 3_600_000;
    if (Math.abs(shiftH) >= 24) {
      const days = Math.round(shiftH / 24);
      await notify(item, 'eta', `ETA зсунулась на ${days > 0 ? '+' : ''}${days} дн. (тепер ${fmtDate(eta)}, внесено вручну).`, actorId);
    }
  }
}

export async function addManualEvent(
  item: TrackedRow,
  e: { at: string | null; location: string; description: string; planned: boolean },
): Promise<void> {
  const prefer = item.mode === 'air' ? 'air' : item.mode === 'sea' ? 'sea' : undefined;
  const pos = e.location ? await geocode(e.location, prefer) : null;
  await query(
    `INSERT INTO tracking_events (tracked_id, at, location, lat, lng, description, planned, hash, manual)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) ON CONFLICT (tracked_id, hash) DO NOTHING`,
    [item.id, e.at, e.location.slice(0, 200), pos?.[0] ?? null, pos?.[1] ?? null, e.description.slice(0, 500), e.planned, eventHash(e)],
  );
  // A hand-kept sea item is now "manual"; elsewhere don't mask the carrier source.
  await query(
    `UPDATE tracked_items SET source = 'manual', last_changed_at = now()
     WHERE id = $1 AND ($2 OR source IN ('none', 'manual'))`,
    [item.id, isManualSea(item.mode, item.carrier)],
  );
}

/** Only hand-entered events can be removed — carrier events are the record. */
export async function deleteManualEvent(itemId: string, eventId: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM tracking_events WHERE id = $1 AND tracked_id = $2 AND manual', [
    eventId,
    itemId,
  ]);
  return !!rowCount;
}

/** Worker cron: re-check items not delivered/archived and not checked recently. */
export async function refreshDue(limit = 60): Promise<{ checked: number; failed: number }> {
  // Manual-mode sea items are skipped (logists maintain them by hand).
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM tracked_items
     WHERE NOT archived AND status <> 'delivered'
       AND (last_checked_at IS NULL OR last_checked_at < now() - interval '25 minutes')
       AND NOT (mode = 'sea' AND $2::boolean AND NOT (carrier = 'maersk' AND $3::boolean))
     ORDER BY last_checked_at NULLS FIRST LIMIT $1`,
    [limit, config.TRACKING_SEA_MODE === 'manual', !!config.MAERSK_API_KEY],
  );
  let failed = 0;
  for (const r of rows) {
    try {
      await refreshTracked(r.id);
    } catch {
      failed += 1;
    }
  }
  // Delivered items are archived from the live map after 14 days.
  await query(
    `UPDATE tracked_items SET archived = TRUE
     WHERE status = 'delivered' AND NOT archived AND COALESCE(arrived_at, last_changed_at) < now() - interval '14 days'`,
  );
  return { checked: rows.length, failed };
}
