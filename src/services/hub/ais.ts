import WebSocket from 'ws';
import { config } from '../../config.js';
import { query } from '../../db/pool.js';

/**
 * aisstream.io live AIS client (worker-side, free API key).
 *
 *  - "ambient" stream: every vessel in the Black Sea / Danube / Bosporus box —
 *    the live traffic around Ukrainian ports on the hub map.
 *  - "tracked" stream: worldwide, filtered to the MMSIs of vessels carrying our
 *    tracked containers (≤50 per subscription — aisstream's limit).
 *  - "resolver": while some tracked vessels are known only by name/IMO (that is
 *    what carriers publish), a time-boxed ShipStaticData listen maps them to an
 *    MMSI, then closes.
 *
 * Positions are buffered in memory and upserted every 10 s; rows older than
 * 6 h are pruned. Everything degrades silently: no key → nothing runs and the
 * map falls back to event/ETA estimates.
 */

const URL = 'wss://stream.aisstream.io/v0/stream';
const AMBIENT_BOXES = [
  [
    [40.6, 26.8],
    [47.2, 42.0],
  ],
];
const WORLD = [
  [
    [-90, -180],
    [90, 180],
  ],
];

interface Fix {
  mmsi: string;
  name: string;
  imo: string;
  lat: number;
  lng: number;
  sog: number | null;
  cog: number | null;
  type: number | null;
}

const buffer = new Map<string, Partial<Fix>>();
const timers: NodeJS.Timeout[] = [];
const sockets = new Map<string, WebSocket>();
let trackedKey = '';
let stopped = false;

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function onMessage(raw: WebSocket.RawData, onStatic?: (s: { mmsi: string; imo: string; name: string }) => void): void {
  let msg: Obj;
  try {
    msg = JSON.parse(raw.toString()) as Obj;
  } catch {
    return;
  }
  const meta = o(msg.MetaData);
  const mmsi = String(meta.MMSI ?? '');
  if (!mmsi) return;
  const type = String(msg.MessageType ?? '');
  const body = o(o(msg.Message)[type]);
  const cur = buffer.get(mmsi) ?? { mmsi };
  const name = String(meta.ShipName ?? '').trim();
  if (name) cur.name = name;
  if (type === 'PositionReport' || type === 'StandardClassBPositionReport') {
    const lat = num(body.Latitude) ?? num(meta.latitude);
    const lng = num(body.Longitude) ?? num(meta.longitude);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    cur.lat = lat;
    cur.lng = lng;
    const sog = num(body.Sog);
    const cog = num(body.Cog);
    cur.sog = sog != null && sog < 102.3 ? sog : null;
    cur.cog = cog != null && cog < 360 ? cog : null;
  } else if (type === 'ShipStaticData') {
    const imo = num(body.ImoNumber);
    if (imo) cur.imo = String(imo);
    const t = num(body.Type);
    if (t != null) cur.type = t;
    const sname = String(body.Name ?? '').trim();
    if (sname) cur.name = sname;
    onStatic?.({ mmsi, imo: imo ? String(imo) : '', name: sname || name });
  }
  buffer.set(mmsi, cur);
}

async function flush(): Promise<void> {
  if (buffer.size === 0) return;
  const batch = [...buffer.values()];
  buffer.clear();
  for (const f of batch) {
    if (f.lat == null || f.lng == null) {
      if (f.name || f.imo || f.type != null) {
        await query(
          `UPDATE vessel_positions SET
             name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
             imo = CASE WHEN $3 <> '' THEN $3 ELSE imo END,
             ship_type = COALESCE($4, ship_type)
           WHERE mmsi = $1`,
          [f.mmsi, f.name ?? '', f.imo ?? '', f.type ?? null],
        ).catch(() => undefined);
      }
      continue;
    }
    await query(
      `INSERT INTO vessel_positions (mmsi, imo, name, lat, lng, sog, cog, ship_type, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (mmsi) DO UPDATE SET
         lat = EXCLUDED.lat, lng = EXCLUDED.lng, sog = EXCLUDED.sog, cog = EXCLUDED.cog,
         name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE vessel_positions.name END,
         imo = CASE WHEN EXCLUDED.imo <> '' THEN EXCLUDED.imo ELSE vessel_positions.imo END,
         ship_type = COALESCE(EXCLUDED.ship_type, vessel_positions.ship_type),
         updated_at = now()`,
      [f.mmsi, f.imo ?? '', f.name ?? '', f.lat, f.lng, f.sog ?? null, f.cog ?? null, f.type ?? null],
    ).catch(() => undefined);
  }
}

function open(
  key: string,
  subscription: Obj,
  onStatic?: (s: { mmsi: string; imo: string; name: string }) => void,
): void {
  sockets.get(key)?.close();
  const ws = new WebSocket(URL);
  sockets.set(key, ws);
  ws.on('open', () => ws.send(JSON.stringify({ APIKey: config.AISSTREAM_API_KEY, ...subscription })));
  ws.on('message', (data) => onMessage(data, onStatic));
  ws.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`AIS [${key}] error:`, err.message);
  });
  ws.on('close', () => {
    if (sockets.get(key) !== ws || stopped) return;
    sockets.delete(key);
    // Reconnect persistent streams after a pause.
    if (key !== 'resolver') {
      const t = setTimeout(() => open(key, subscription, onStatic), 30_000);
      timers.push(t);
    }
  });
}

async function syncTracked(): Promise<void> {
  const { rows } = await query<{ vessel_mmsi: string }>(
    `SELECT DISTINCT vessel_mmsi FROM tracked_items
     WHERE NOT archived AND mode = 'sea' AND vessel_mmsi <> '' AND status NOT IN ('delivered')
     LIMIT 50`,
  );
  const mmsis = rows.map((r) => r.vessel_mmsi).sort();
  const key = mmsis.join(',');
  if (key === trackedKey) return;
  trackedKey = key;
  if (mmsis.length === 0) {
    sockets.get('tracked')?.close();
    sockets.delete('tracked');
    return;
  }
  open('tracked', {
    BoundingBoxes: WORLD,
    FiltersShipMMSI: mmsis,
    FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
  });
}

async function resolveNames(): Promise<void> {
  if (sockets.has('resolver')) return;
  const { rows } = await query<{ vessel_name: string; vessel_imo: string }>(
    `SELECT DISTINCT vessel_name, vessel_imo FROM tracked_items
     WHERE NOT archived AND mode = 'sea' AND vessel_mmsi = '' AND (vessel_name <> '' OR vessel_imo <> '')
       AND status NOT IN ('delivered')`,
  );
  if (rows.length === 0) return;
  // Known already from the ambient stream?
  for (const r of rows) {
    await query(
      `UPDATE tracked_items t SET vessel_mmsi = v.mmsi FROM vessel_positions v
       WHERE t.vessel_mmsi = '' AND ((t.vessel_imo <> '' AND v.imo = t.vessel_imo)
         OR (t.vessel_name <> '' AND upper(v.name) = upper(t.vessel_name)))
         AND t.vessel_name = $1 AND t.vessel_imo = $2`,
      [r.vessel_name, r.vessel_imo],
    );
  }
  const wantImo = new Set(rows.map((r) => r.vessel_imo).filter(Boolean));
  const wantName = new Set(rows.map((r) => r.vessel_name.toUpperCase()).filter(Boolean));
  open('resolver', { BoundingBoxes: WORLD, FilterMessageTypes: ['ShipStaticData'] }, (s) => {
    if (!(wantImo.has(s.imo) || wantName.has(s.name.toUpperCase()))) return;
    void query(
      `UPDATE tracked_items SET vessel_mmsi = $1
       WHERE vessel_mmsi = '' AND ((vessel_imo <> '' AND vessel_imo = $2) OR upper(vessel_name) = upper($3))`,
      [s.mmsi, s.imo, s.name],
    ).catch(() => undefined);
  });
  // Static data repeats every ~6 min per ship: a 10-minute listen is enough.
  const t = setTimeout(() => {
    sockets.get('resolver')?.close();
    sockets.delete('resolver');
    void syncTracked();
  }, 10 * 60_000);
  timers.push(t);
}

export function aisEnabled(): boolean {
  return config.AISSTREAM_API_KEY.trim().length > 0;
}

export async function startAis(): Promise<void> {
  if (!aisEnabled()) return;
  stopped = false;
  open('ambient', {
    BoundingBoxes: AMBIENT_BOXES,
    FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport'],
  });
  await syncTracked();
  await resolveNames();
  timers.push(setInterval(() => void flush(), 10_000));
  timers.push(setInterval(() => void syncTracked().catch(() => undefined), 5 * 60_000));
  timers.push(setInterval(() => void resolveNames().catch(() => undefined), 60 * 60_000));
  timers.push(
    setInterval(
      () => void query(`DELETE FROM vessel_positions WHERE updated_at < now() - interval '6 hours'`).catch(() => undefined),
      30 * 60_000,
    ),
  );
}

export async function stopAis(): Promise<void> {
  stopped = true;
  for (const t of timers) clearTimeout(t);
  for (const ws of sockets.values()) ws.close();
  sockets.clear();
  await flush().catch(() => undefined);
}
