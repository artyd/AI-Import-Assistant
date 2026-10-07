import { query } from '../../db/pool.js';
import { insertNotification } from '../notifications.js';
import { haversineKm } from './geo.js';
import { PLACES, type PlaceKind } from './places.js';

/**
 * Logistics hub — Phase 2: ports, cargo airports, border crossings and inland
 * hubs with a live operating status.
 *
 * Status model: team-wide marks in `port_status_marks`, each either from the AI
 * (read out of a news item — always with that item's link) or from a logist.
 * The current status is the newest non-expired mark. AI marks live 5 days, a
 * logist's mark 72 h; confirming an AI mark extends it. No mark ⇒ "немає даних"
 * — the hub never assumes a port is working.
 */

export type PortStatus = 'ok' | 'congested' | 'disrupted' | 'closed';
export const PORT_STATUSES: readonly PortStatus[] = ['ok', 'congested', 'disrupted', 'closed'];

export const PORT_STATUS_UK: Record<PortStatus, string> = {
  ok: 'Працює',
  congested: 'Черги / перевантаження',
  disrupted: 'Збої в роботі',
  closed: 'Закрито',
};

const AI_TTL_H = 5 * 24;
const USER_TTL_H = 72;

/** Upsert the gazetteer into `ports` (idempotent; called on server boot). */
export async function seedPlaces(): Promise<void> {
  for (const p of PLACES) {
    await query(
      `INSERT INTO ports (code, name, country, lat, lng, kind, name_en, aliases)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name, country = EXCLUDED.country, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
         kind = EXCLUDED.kind, name_en = EXCLUDED.name_en, aliases = EXCLUDED.aliases
       WHERE (ports.name, ports.lat, ports.lng, ports.kind, ports.name_en, ports.aliases)
         IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.lat, EXCLUDED.lng, EXCLUDED.kind, EXCLUDED.name_en, EXCLUDED.aliases)`,
      [p.code, p.name, p.country, p.lat, p.lng, p.kind, p.nameEn, p.aliases ?? []],
    );
  }
}

interface PortRow {
  code: string;
  name: string;
  name_en: string;
  country: string;
  lat: number;
  lng: number;
  kind: PlaceKind;
  mark_id: string | null;
  status: PortStatus | null;
  note: string | null;
  source: 'ai' | 'user' | null;
  source_url: string | null;
  source_title: string | null;
  confidence: number | null;
  mark_at: string | null;
  confirmed_by: string[] | null;
  user_name: string | null;
  favorite: boolean;
}

const PORT_SELECT = `
  SELECT p.code, p.name, p.name_en, p.country, p.lat, p.lng, p.kind,
         m.id AS mark_id, m.status, m.note, m.source, m.source_url, m.source_title,
         m.confidence, m.created_at AS mark_at, m.confirmed_by, u.name AS user_name,
         (f.user_id IS NOT NULL) AS favorite
  FROM ports p
  LEFT JOIN LATERAL (
    SELECT * FROM port_status_marks x
    WHERE x.port_code = p.code AND x.valid_until > now()
    ORDER BY x.created_at DESC LIMIT 1
  ) m ON TRUE
  LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN port_favorites f ON f.port_code = p.code AND f.user_id = $1`;

export function serializePort(r: PortRow, trackCount = 0) {
  return {
    code: r.code,
    name: r.name,
    nameEn: r.name_en,
    country: r.country,
    lat: r.lat,
    lng: r.lng,
    kind: r.kind,
    favorite: r.favorite,
    trackCount,
    status: r.status
      ? {
          markId: r.mark_id,
          status: r.status,
          label: PORT_STATUS_UK[r.status],
          note: r.note ?? '',
          by: r.source,
          userName: r.user_name ?? '',
          sourceUrl: r.source_url ?? '',
          sourceTitle: r.source_title ?? '',
          confidence: r.confidence,
          updatedAt: r.mark_at,
          confirmations: r.confirmed_by?.length ?? 0,
        }
      : null,
  };
}

export type PortDto = ReturnType<typeof serializePort>;

/** Active tracked items (visible to the user) per port, by destination/origin proximity. */
async function trackCounts(userId: string): Promise<Array<{ lat: number; lng: number }>> {
  const { rows } = await query<{ lat: number; lng: number }>(
    `SELECT dest_lat AS lat, dest_lng AS lng FROM tracked_items t
     WHERE NOT archived AND status <> 'delivered' AND dest_lat IS NOT NULL
       AND (t.owner_id = $1 OR t.workspace_id IN (SELECT id FROM workspaces WHERE owner_id = $1))`,
    [userId],
  );
  return rows;
}

export async function listPorts(userId: string): Promise<PortDto[]> {
  const { rows } = await query<PortRow>(`${PORT_SELECT} ORDER BY p.kind, p.name`, [userId]);
  const dests = await trackCounts(userId);
  return rows.map((r) =>
    serializePort(r, dests.filter((d) => haversineKm([d.lat, d.lng], [r.lat, r.lng]) < 40).length),
  );
}

export async function getPort(userId: string, code: string) {
  const { rows } = await query<PortRow>(`${PORT_SELECT} WHERE p.code = $2`, [userId, code.toUpperCase()]);
  const r = rows[0];
  if (!r) return null;
  const history = await query<{
    id: string;
    status: PortStatus;
    note: string;
    source: 'ai' | 'user';
    source_url: string;
    source_title: string;
    created_at: string;
    valid_until: string;
    user_name: string | null;
    confirmations: number;
  }>(
    `SELECT m.id, m.status, m.note, m.source, m.source_url, m.source_title, m.created_at, m.valid_until,
            u.name AS user_name, cardinality(m.confirmed_by) AS confirmations
     FROM port_status_marks m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.port_code = $1 ORDER BY m.created_at DESC LIMIT 12`,
    [r.code],
  );
  const tracks = await query<{ id: string; number: string; label: string; status: string; eta: string | null; dest_lat: number; dest_lng: number }>(
    `SELECT id, number, label, status, eta, dest_lat, dest_lng FROM tracked_items t
     WHERE NOT archived AND dest_lat IS NOT NULL
       AND (t.owner_id = $1 OR t.workspace_id IN (SELECT id FROM workspaces WHERE owner_id = $1))`,
    [userId],
  );
  const near = tracks.rows.filter((t) => haversineKm([t.dest_lat, t.dest_lng], [r.lat, r.lng]) < 40);
  return {
    port: serializePort(r, near.length),
    history: history.rows.map((h) => ({
      id: h.id,
      status: h.status,
      label: PORT_STATUS_UK[h.status],
      note: h.note,
      by: h.source,
      userName: h.user_name ?? '',
      sourceUrl: h.source_url,
      sourceTitle: h.source_title,
      createdAt: h.created_at,
      validUntil: h.valid_until,
      confirmations: h.confirmations,
    })),
    tracks: near.map((t) => ({ id: t.id, number: t.number, label: t.label, status: t.status, eta: t.eta })),
  };
}

async function currentStatus(code: string): Promise<PortStatus | null> {
  const { rows } = await query<{ status: PortStatus }>(
    `SELECT status FROM port_status_marks WHERE port_code = $1 AND valid_until > now()
     ORDER BY created_at DESC LIMIT 1`,
    [code],
  );
  return rows[0]?.status ?? null;
}

/** Tell everyone who starred the port when it stops / resumes working. */
async function notifyFavorites(code: string, before: PortStatus | null, after: PortStatus, note: string): Promise<void> {
  if (before === after) return;
  const bad = (s: PortStatus | null) => s === 'closed' || s === 'disrupted';
  if (!bad(after) && !(bad(before) && after === 'ok')) return;
  const { rows } = await query<{ user_id: string; name: string }>(
    `SELECT f.user_id, p.name FROM port_favorites f JOIN ports p ON p.code = f.port_code WHERE f.port_code = $1`,
    [code],
  );
  for (const r of rows) {
    await insertNotification(
      r.user_id,
      null,
      `port:${code}:${after}`,
      `⚓ ${r.name}: ${PORT_STATUS_UK[after]}${note ? ` — ${note.slice(0, 140)}` : ''}`,
    );
  }
}

export async function addMark(input: {
  code: string;
  status: PortStatus;
  note?: string;
  source: 'ai' | 'user';
  userId?: string | null;
  sourceUrl?: string;
  sourceTitle?: string;
  confidence?: number | null;
}): Promise<boolean> {
  const code = input.code.toUpperCase();
  const exists = await query('SELECT 1 FROM ports WHERE code = $1', [code]);
  if (!exists.rowCount) return false;
  const before = await currentStatus(code);
  const ttl = input.source === 'ai' ? AI_TTL_H : USER_TTL_H;
  await query(
    `INSERT INTO port_status_marks
       (port_code, status, note, source, source_url, source_title, confidence, user_id, valid_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' hours')::interval)`,
    [
      code,
      input.status,
      (input.note ?? '').slice(0, 500),
      input.source,
      (input.sourceUrl ?? '').slice(0, 500),
      (input.sourceTitle ?? '').slice(0, 300),
      input.confidence ?? null,
      input.userId ?? null,
      String(ttl),
    ],
  );
  await notifyFavorites(code, before, input.status, input.note ?? '');
  return true;
}

/** A logist confirms the current mark (typically an AI one): it lives 72 h more. */
export async function confirmMark(userId: string, code: string, markId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE port_status_marks SET
       confirmed_by = CASE WHEN $3 = ANY(confirmed_by) THEN confirmed_by ELSE array_append(confirmed_by, $3::uuid) END,
       valid_until = GREATEST(valid_until, now() + interval '${USER_TTL_H} hours')
     WHERE id = $1 AND port_code = $2 AND valid_until > now()`,
    [markId, code.toUpperCase(), userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function setFavorite(userId: string, code: string, on: boolean): Promise<boolean> {
  const c = code.toUpperCase();
  const exists = await query('SELECT 1 FROM ports WHERE code = $1', [c]);
  if (!exists.rowCount) return false;
  if (on) {
    await query('INSERT INTO port_favorites (user_id, port_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, c]);
  } else {
    await query('DELETE FROM port_favorites WHERE user_id = $1 AND port_code = $2', [userId, c]);
  }
  return true;
}

/** Ports matching a free-text query (code / UA name / EN name / alias). */
export async function findPorts(q: string, limit = 5): Promise<PortRow[]> {
  const t = q.trim();
  if (!t) return [];
  const { rows } = await query<PortRow>(
    `${PORT_SELECT}
     WHERE p.code = upper($2) OR p.name ILIKE '%' || $2 || '%' OR p.name_en ILIKE '%' || $2 || '%'
        OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE a ILIKE '%' || $2 || '%')
     ORDER BY (p.code = upper($2)) DESC, length(p.name) LIMIT $3`,
    ['00000000-0000-0000-0000-000000000000', t, limit],
  );
  return rows;
}
