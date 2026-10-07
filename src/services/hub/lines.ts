import { query } from '../../db/pool.js';
import { CARRIERS, getCarrier } from './carriers.js';
import { haversineKm, pathLengthKm, seaRoute, type LatLng } from './geo.js';
import { placeByCode } from './places.js';

/**
 * Logistics hub — Phase 3: sea lines.
 *
 *  - Carrier status (team-wide, provenance-tracked like port marks): bookings to
 *    Ukraine (accepting / limited / suspended), Asia–Europe routing (Suez / Cape /
 *    mixed), war-risk surcharge note. Each field = newest non-expired non-null
 *    value, so a news item that only mentions rerouting doesn't erase the
 *    Ukraine status. Unknown stays unknown.
 *  - Services the team uses (rotation, transit, frequency) — entered by logists.
 *  - Reference lanes: Asia / India / Turkey / North-Europe → Black Sea corridors
 *    with a transit estimate COMPUTED from the sea-lane distance (labelled
 *    "орієнтовно"), not a carrier schedule.
 *  - Reliability: on-time share and average delay per carrier from the team's
 *    own delivered sea shipments (arrival vs. the first ETA we saw).
 */

export type UaStatus = 'accepting' | 'limited' | 'suspended';
export type RedSea = 'suez' | 'cape' | 'mixed';

export const UA_STATUS_UK: Record<UaStatus, string> = {
  accepting: 'Приймає букінги на Україну',
  limited: 'Обмежено / з умовами',
  suspended: 'Не приймає на Україну',
};
export const RED_SEA_UK: Record<RedSea, string> = {
  suez: 'Через Суец',
  cape: 'В обхід Африки',
  mixed: 'Змішано',
};

const AI_TTL_H = 10 * 24;
const USER_TTL_H = 14 * 24;

export const SEA_CARRIERS = CARRIERS.filter((c) => c.mode === 'sea' && c.id !== 'sea-generic');

interface MarkRow {
  id: string;
  carrier: string;
  ua_status: UaStatus | null;
  red_sea: RedSea | null;
  war_risk: string;
  note: string;
  source: 'ai' | 'user';
  source_url: string;
  source_title: string;
  confidence: number | null;
  user_name: string | null;
  confirmations: number;
  created_at: string;
}

interface FieldValue<T> {
  value: T;
  markId: string;
  by: 'ai' | 'user';
  userName: string;
  sourceUrl: string;
  sourceTitle: string;
  note: string;
  updatedAt: string;
  confirmations: number;
}

function field<T>(m: MarkRow, value: T): FieldValue<T> {
  return {
    value,
    markId: m.id,
    by: m.source,
    userName: m.user_name ?? '',
    sourceUrl: m.source_url,
    sourceTitle: m.source_title,
    note: m.note,
    updatedAt: m.created_at,
    confirmations: m.confirmations,
  };
}

async function activeMarks(carrier?: string): Promise<MarkRow[]> {
  const { rows } = await query<MarkRow>(
    `SELECT m.id, m.carrier, m.ua_status, m.red_sea, m.war_risk, m.note, m.source, m.source_url,
            m.source_title, m.confidence, u.name AS user_name, cardinality(m.confirmed_by) AS confirmations,
            m.created_at
     FROM carrier_status_marks m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.valid_until > now() ${carrier ? 'AND m.carrier = $1' : ''}
     ORDER BY m.created_at DESC`,
    carrier ? [carrier] : [],
  );
  return rows;
}

export interface Reliability {
  delivered: number;
  onTimeShare: number | null;
  avgDelayDays: number | null;
  inTransit: number;
}

/** Team-wide, aggregate only (no item details leak across users). */
async function reliabilityAll(): Promise<Map<string, Reliability>> {
  const { rows } = await query<{ carrier: string; delivered: string; on_time: string; avg_delay: number | null; in_transit: string }>(
    `SELECT carrier,
            count(*) FILTER (WHERE arrived_at IS NOT NULL AND first_eta IS NOT NULL) AS delivered,
            count(*) FILTER (WHERE arrived_at IS NOT NULL AND first_eta IS NOT NULL
                               AND arrived_at <= first_eta + interval '1 day') AS on_time,
            avg(EXTRACT(EPOCH FROM (arrived_at - first_eta)) / 86400)
              FILTER (WHERE arrived_at IS NOT NULL AND first_eta IS NOT NULL) AS avg_delay,
            count(*) FILTER (WHERE status IN ('in_transit', 'at_port', 'customs') AND NOT archived) AS in_transit
     FROM tracked_items WHERE mode = 'sea' GROUP BY carrier`,
  );
  const out = new Map<string, Reliability>();
  for (const r of rows) {
    const n = Number(r.delivered);
    out.set(r.carrier, {
      delivered: n,
      onTimeShare: n >= 3 ? Number(r.on_time) / n : null,
      avgDelayDays: n >= 3 && r.avg_delay != null ? Math.round(r.avg_delay * 10) / 10 : null,
      inTransit: Number(r.in_transit),
    });
  }
  return out;
}

function summarize(carrier: string, marks: MarkRow[], rel: Reliability | undefined) {
  const mine = marks.filter((m) => m.carrier === carrier);
  const ua = mine.find((m) => m.ua_status);
  const rs = mine.find((m) => m.red_sea);
  const wr = mine.find((m) => m.war_risk);
  return {
    id: carrier,
    name: getCarrier(carrier)?.name ?? carrier,
    uaStatus: ua ? { ...field(ua, ua.ua_status!), label: UA_STATUS_UK[ua.ua_status!] } : null,
    redSea: rs ? { ...field(rs, rs.red_sea!), label: RED_SEA_UK[rs.red_sea!] } : null,
    warRisk: wr ? field(wr, wr.war_risk) : null,
    reliability: rel ?? { delivered: 0, onTimeShare: null, avgDelayDays: null, inTransit: 0 },
    updatedAt: mine[0]?.created_at ?? null,
  };
}

export type CarrierSummary = ReturnType<typeof summarize>;

export async function listCarriers(): Promise<CarrierSummary[]> {
  const [marks, rel] = await Promise.all([activeMarks(), reliabilityAll()]);
  return SEA_CARRIERS.map((c) => summarize(c.id, marks, rel.get(c.id)));
}

export interface ServiceRow {
  id: string;
  carrier: string;
  name: string;
  rotation: string[];
  transit_days_min: number | null;
  transit_days_max: number | null;
  frequency: string;
  via: '' | 'suez' | 'cape';
  note: string;
  created_by_name: string | null;
  updated_at: string;
}

export function serializeService(s: ServiceRow) {
  return {
    id: s.id,
    carrier: s.carrier,
    name: s.name,
    rotation: s.rotation.map((code) => ({ code, name: placeByCode(code)?.name ?? code })),
    transitDaysMin: s.transit_days_min,
    transitDaysMax: s.transit_days_max,
    frequency: s.frequency,
    via: s.via,
    note: s.note,
    createdBy: s.created_by_name ?? '',
    updatedAt: s.updated_at,
    path: servicePath(s.rotation, s.via === 'cape'),
  };
}

export async function getCarrierDetail(carrier: string) {
  if (!SEA_CARRIERS.some((c) => c.id === carrier)) return null;
  const [marks, rel, services, history] = await Promise.all([
    activeMarks(carrier),
    reliabilityAll(),
    query<ServiceRow>(
      `SELECT s.*, u.name AS created_by_name FROM carrier_services s LEFT JOIN users u ON u.id = s.created_by
       WHERE s.carrier = $1 ORDER BY s.updated_at DESC`,
      [carrier],
    ),
    query<MarkRow>(
      `SELECT m.id, m.carrier, m.ua_status, m.red_sea, m.war_risk, m.note, m.source, m.source_url, m.source_title,
              m.confidence, u.name AS user_name, cardinality(m.confirmed_by) AS confirmations, m.created_at
       FROM carrier_status_marks m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.carrier = $1 ORDER BY m.created_at DESC LIMIT 15`,
      [carrier],
    ),
  ]);
  return {
    carrier: summarize(carrier, marks, rel.get(carrier)),
    services: services.rows.map(serializeService),
    history: history.rows.map((m) => ({
      id: m.id,
      uaStatus: m.ua_status,
      redSea: m.red_sea,
      warRisk: m.war_risk,
      note: m.note,
      by: m.source,
      userName: m.user_name ?? '',
      sourceUrl: m.source_url,
      sourceTitle: m.source_title,
      createdAt: m.created_at,
    })),
  };
}

export async function addCarrierMark(input: {
  carrier: string;
  uaStatus?: UaStatus | null;
  redSea?: RedSea | null;
  warRisk?: string;
  note?: string;
  source: 'ai' | 'user';
  userId?: string | null;
  sourceUrl?: string;
  sourceTitle?: string;
  confidence?: number | null;
}): Promise<boolean> {
  if (!SEA_CARRIERS.some((c) => c.id === input.carrier)) return false;
  if (!input.uaStatus && !input.redSea && !input.warRisk?.trim() && !input.note?.trim()) return false;
  await query(
    `INSERT INTO carrier_status_marks
       (carrier, ua_status, red_sea, war_risk, note, source, source_url, source_title, confidence, user_id, valid_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + ($11 || ' hours')::interval)`,
    [
      input.carrier,
      input.uaStatus ?? null,
      input.redSea ?? null,
      (input.warRisk ?? '').slice(0, 200),
      (input.note ?? '').slice(0, 500),
      input.source,
      (input.sourceUrl ?? '').slice(0, 500),
      (input.sourceTitle ?? '').slice(0, 300),
      input.confidence ?? null,
      input.userId ?? null,
      String(input.source === 'ai' ? AI_TTL_H : USER_TTL_H),
    ],
  );
  return true;
}

export async function confirmCarrierMark(userId: string, carrier: string, markId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE carrier_status_marks SET
       confirmed_by = CASE WHEN $3 = ANY(confirmed_by) THEN confirmed_by ELSE array_append(confirmed_by, $3::uuid) END,
       valid_until = GREATEST(valid_until, now() + interval '${USER_TTL_H} hours')
     WHERE id = $1 AND carrier = $2 AND valid_until > now()`,
    [markId, carrier, userId],
  );
  return (rowCount ?? 0) > 0;
}

export interface ServiceInput {
  carrier: string;
  name: string;
  rotation: string[];
  transitDaysMin?: number | null;
  transitDaysMax?: number | null;
  frequency?: string;
  via?: '' | 'suez' | 'cape';
  note?: string;
}

export function validRotation(codes: string[]): string[] {
  return codes.map((c) => c.trim().toUpperCase()).filter((c) => placeByCode(c));
}

export async function upsertService(userId: string, input: ServiceInput, id?: string): Promise<string | null> {
  if (!SEA_CARRIERS.some((c) => c.id === input.carrier)) return null;
  const rotation = validRotation(input.rotation);
  const params = [
    input.carrier,
    input.name.slice(0, 120),
    rotation,
    input.transitDaysMin ?? null,
    input.transitDaysMax ?? null,
    (input.frequency ?? '').slice(0, 60),
    input.via ?? '',
    (input.note ?? '').slice(0, 500),
    userId,
  ];
  if (id) {
    const { rows } = await query<{ id: string }>(
      `UPDATE carrier_services SET carrier = $1, name = $2, rotation = $3, transit_days_min = $4,
         transit_days_max = $5, frequency = $6, via = $7, note = $8, created_by = COALESCE(created_by, $9),
         updated_at = now()
       WHERE id = $10 RETURNING id`,
      [...params, id],
    );
    return rows[0]?.id ?? null;
  }
  const { rows } = await query<{ id: string }>(
    `INSERT INTO carrier_services (carrier, name, rotation, transit_days_min, transit_days_max, frequency, via, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    params,
  );
  return rows[0]!.id;
}

export async function deleteService(id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM carrier_services WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

// ── Reference lanes (computed, labelled "орієнтовно") ───────────────────────

/** Geometry through each consecutive pair of rotation ports. */
export function servicePath(rotation: string[], avoidRedSea: boolean): LatLng[] {
  const pts = rotation.map((c) => placeByCode(c)).filter((p): p is NonNullable<typeof p> => !!p);
  const out: LatLng[] = [];
  for (let i = 1; i < pts.length; i += 1) {
    const seg = seaRoute([pts[i - 1]!.lat, pts[i - 1]!.lng], [pts[i]!.lat, pts[i]!.lng], { avoidRedSea });
    out.push(...(i === 1 ? seg : seg.slice(1)));
  }
  return out.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
}

/** Days at sea at `knots` plus ~1.5 days per intermediate call. */
export function estimateTransitDays(path: LatLng[], calls: number, knots = 15): { min: number; max: number } {
  const nm = pathLengthKm(path) / 1.852;
  const sea = nm / (knots * 24);
  const base = sea + Math.max(0, calls - 2) * 1.5 + 2;
  return { min: Math.round(base * 0.92), max: Math.round(base * 1.15) };
}

interface LaneDef {
  id: string;
  name: string;
  rotation: string[];
  via: 'suez' | 'cape';
}

const LANES: LaneDef[] = [
  { id: 'cn-ods-suez', name: 'Китай → Одеса (через Суец)', rotation: ['CNSHA', 'CNNGB', 'SGSIN', 'TRAMR', 'UAODS'], via: 'suez' },
  { id: 'cn-ods-cape', name: 'Китай → Одеса (в обхід Африки)', rotation: ['CNSHA', 'CNNGB', 'SGSIN', 'TRAMR', 'UAODS'], via: 'cape' },
  { id: 'cn-cnd-suez', name: 'Китай → Констанца (через Суец)', rotation: ['CNSHA', 'SGSIN', 'GRPIR', 'ROCND'], via: 'suez' },
  { id: 'cn-cnd-cape', name: 'Китай → Констанца (в обхід Африки)', rotation: ['CNSHA', 'SGSIN', 'ROCND'], via: 'cape' },
  { id: 'in-ods-suez', name: 'Індія → Одеса (через Суец)', rotation: ['INNSA', 'INMUN', 'TRAMR', 'UAODS'], via: 'suez' },
  { id: 'in-ods-cape', name: 'Індія → Одеса (в обхід Африки)', rotation: ['INNSA', 'INMUN', 'TRAMR', 'UAODS'], via: 'cape' },
  { id: 'cn-gdn-suez', name: 'Китай → Гданськ (+ авто до України)', rotation: ['CNSHA', 'SGSIN', 'NLRTM', 'PLGDN'], via: 'suez' },
  { id: 'cn-gdn-cape', name: 'Китай → Гданськ в обхід Африки (+ авто)', rotation: ['CNSHA', 'SGSIN', 'NLRTM', 'PLGDN'], via: 'cape' },
  { id: 'tr-ods', name: 'Туреччина → Одеса (фідер)', rotation: ['TRAMR', 'UAODS'], via: 'suez' },
  { id: 'eu-cnd-danube', name: 'Пірей → Констанца → Дунай', rotation: ['GRPIR', 'ROCND', 'UAIZM'], via: 'suez' },
];

export function referenceLanes() {
  return LANES.map((l) => {
    const path = servicePath(l.rotation, l.via === 'cape');
    const t = estimateTransitDays(path, l.rotation.length);
    return {
      id: l.id,
      name: l.name,
      via: l.via,
      rotation: l.rotation.map((code) => ({ code, name: placeByCode(code)?.name ?? code })),
      transitDaysMin: t.min,
      transitDaysMax: t.max,
      distanceNm: Math.round(pathLengthKm(path) / 1.852),
      path,
    };
  });
}

/** Lanes passing within `km` of a point (used by the route builder). */
export function lanesNear(p: LatLng, km = 150) {
  return referenceLanes().filter((l) => l.path.some((q) => haversineKm(p, q) < km));
}
