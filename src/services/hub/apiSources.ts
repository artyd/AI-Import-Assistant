import { config } from '../../config.js';
import { toIso, type TrackEventIn, type TrackResult, type TrackStatus } from './types.js';

/**
 * Official carrier APIs (the first tier of the hybrid tracking source). Each
 * adapter returns null when it does not apply (no key configured / wrong
 * carrier) so the orchestrator moves on to the next tier; it throws only on a
 * transport failure, which the orchestrator records as `last_error`.
 *
 *  - Нова Пошта  — public JSON API, works without a key (key = richer data).
 *  - Укрпошта    — status-tracking API, needs UKRPOSHTA_TRACKING_TOKEN.
 *  - DHL         — Shipment Tracking – Unified, needs DHL_API_KEY.
 *  - Maersk      — Track & Trace (DCSA events), needs MAERSK_API_KEY.
 *  - 17TRACK     — parcels / express aggregator, needs TRACK17_API_KEY.
 */

const TIMEOUT_MS = 15_000;

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v)).trim();
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ── Нова Пошта ───────────────────────────────────────────────────────────────

/** NP StatusCode → hub status (codes per NP API "TrackingDocument" docs). */
export function npStatus(code: string): TrackStatus {
  const c = Number(code);
  if (c === 3) return 'unknown';
  if (c === 1) return 'info';
  if ([2, 102, 103, 105, 108, 111].includes(c)) return 'exception';
  if ([9, 10, 11, 106].includes(c)) return 'delivered';
  if ([7, 8, 101].includes(c)) return 'out_for_delivery';
  if (c === 6) return 'at_port';
  if ([4, 41, 5, 104, 112].includes(c)) return 'in_transit';
  return 'in_transit';
}

export async function trackNovaPoshta(number: string): Promise<TrackResult | null> {
  const body = {
    apiKey: config.NOVAPOSHTA_API_KEY,
    modelName: 'TrackingDocument',
    calledMethod: 'getStatusDocuments',
    methodProperties: { Documents: [{ DocumentNumber: number, Phone: '' }] },
  };
  const json = obj(
    await getJson('https://api.novaposhta.ua/v2.0/json/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  const d = obj(arr(json.data)[0]);
  if (!d.Number) return null;
  const status = npStatus(str(d.StatusCode));
  if (status === 'unknown') {
    return { found: false, status, statusText: str(d.Status), events: [], source: 'api:novaposhta' };
  }
  const delivered = toIso(d.RecipientDateTime) ?? toIso(d.ActualDeliveryDate);
  const where = str(d.WarehouseRecipient) || str(d.CityRecipient);
  const events: TrackEventIn[] = [];
  const created = toIso(d.DateCreated);
  if (created) events.push({ at: created, location: str(d.CitySender), description: 'Створено накладну' });
  events.push({
    at: status === 'delivered' ? delivered : null,
    location: status === 'in_transit' ? str(d.CitySender) : where,
    description: str(d.Status),
  });
  return {
    found: true,
    status,
    statusText: str(d.Status),
    events,
    origin: str(d.CitySender),
    destination: str(d.CityRecipient),
    eta: toIso(d.ScheduledDeliveryDate),
    departedAt: created,
    arrivedAt: status === 'delivered' ? delivered : null,
    source: 'api:novaposhta',
  };
}

// ── Укрпошта ─────────────────────────────────────────────────────────────────

function ukrposhtaStatus(text: string): TrackStatus {
  const t = text.toLowerCase();
  if (/вручен|отримано адресатом|delivered/.test(t)) return 'delivered';
  if (/поверн|поверт|відмов|return/.test(t)) return 'exception';
  if (/митн|customs/.test(t)) return 'customs';
  if (/надійшло до відділення|прибуло до відділення|готове до видачі|arrived at the post office/.test(t))
    return 'out_for_delivery';
  if (/прийнят|створено|accepted/.test(t)) return 'info';
  return 'in_transit';
}

export async function trackUkrposhta(number: string): Promise<TrackResult | null> {
  if (!config.UKRPOSHTA_TRACKING_TOKEN) return null;
  const list = arr(
    await getJson(
      `https://www.ukrposhta.ua/status-tracking/0.0.1/statuses?barcode=${encodeURIComponent(number)}&lang=uk`,
      { headers: { authorization: `Bearer ${config.UKRPOSHTA_TRACKING_TOKEN}`, accept: 'application/json' } },
    ),
  ).map(obj);
  if (list.length === 0) return { found: false, status: 'unknown', statusText: '', events: [], source: 'api:ukrposhta' };
  const events: TrackEventIn[] = list.map((e) => ({
    at: toIso(e.date),
    location: [str(e.name), str(e.country)].filter(Boolean).join(', '),
    description: str(e.eventName) || str(e.event),
  }));
  const last = events[events.length - 1]!;
  const status = ukrposhtaStatus(last.description);
  return {
    found: true,
    status,
    statusText: last.description,
    events,
    origin: events[0]?.location,
    arrivedAt: status === 'delivered' ? last.at : null,
    departedAt: events[0]?.at ?? null,
    source: 'api:ukrposhta',
  };
}

// ── DHL (Unified) ────────────────────────────────────────────────────────────

function dhlStatus(code: string, desc: string): TrackStatus {
  if (code === 'delivered') return 'delivered';
  if (code === 'failure') return 'exception';
  if (code === 'pre-transit') return 'info';
  if (/customs|митн/i.test(desc)) return 'customs';
  if (/out for delivery|with delivery courier/i.test(desc)) return 'out_for_delivery';
  if (code === 'transit') return 'in_transit';
  return 'unknown';
}

const dhlPlace = (v: unknown): string => {
  const a = obj(obj(v).address);
  return [str(a.addressLocality), str(a.countryCode)].filter(Boolean).join(', ');
};

export async function trackDhl(number: string): Promise<TrackResult | null> {
  if (!config.DHL_API_KEY) return null;
  const json = obj(
    await getJson(`https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(number)}`, {
      headers: { 'DHL-API-Key': config.DHL_API_KEY, accept: 'application/json' },
    }),
  );
  const s = obj(arr(json.shipments)[0]);
  if (!s.id) return { found: false, status: 'unknown', statusText: '', events: [], source: 'api:dhl' };
  const st = obj(s.status);
  const events: TrackEventIn[] = arr(s.events)
    .map(obj)
    .map((e) => ({ at: toIso(e.timestamp), location: dhlPlace(e.location), description: str(e.description) || str(e.status) }))
    .reverse();
  const status = dhlStatus(str(st.statusCode), str(st.description));
  return {
    found: true,
    status,
    statusText: str(st.description) || str(st.status),
    events,
    origin: dhlPlace(s.origin),
    destination: dhlPlace(s.destination),
    eta: toIso(s.estimatedTimeOfDelivery),
    departedAt: events[0]?.at ?? null,
    arrivedAt: status === 'delivered' ? toIso(st.timestamp) : null,
    source: 'api:dhl',
  };
}

// ── Maersk (DCSA Track & Trace events) ───────────────────────────────────────

const DCSA_LABEL: Record<string, string> = {
  GTOT: 'Видано з терміналу (gate out)',
  GTIN: 'Прийнято на термінал (gate in)',
  LOAD: 'Завантажено на судно',
  DISC: 'Вивантажено з судна',
  ARRI: 'Прибуття судна',
  DEPA: 'Відхід судна',
  STUF: 'Контейнер завантажено',
  STRP: 'Контейнер розвантажено',
};

/** Parse a DCSA events payload (Maersk and other DCSA-compliant lines). */
export function parseDcsaEvents(payload: unknown, source: string): TrackResult {
  const raw = Array.isArray(payload) ? payload : arr(obj(payload).events);
  const events: TrackEventIn[] = [];
  let vesselName = '';
  let vesselImo = '';
  let eta: string | null = null;
  for (const r of raw.map(obj)) {
    const code = str(r.equipmentEventTypeCode) || str(r.transportEventTypeCode);
    const call = obj(r.transportCall);
    const loc = obj(call.location ?? r.eventLocation);
    const location = [str(loc.locationName), str(loc.UNLocationCode)].filter(Boolean).join(' ');
    const vessel = obj(call.vessel);
    const planned = str(r.eventClassifierCode) !== 'ACT';
    if (vessel.vesselName && !planned) vesselName = str(vessel.vesselName);
    if (vessel.vesselIMONumber && !planned) vesselImo = str(vessel.vesselIMONumber);
    const at = toIso(r.eventDateTime);
    if (planned && code === 'ARRI') eta = at;
    events.push({ at, location, description: DCSA_LABEL[code] ?? code, planned });
  }
  events.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const actual = events.filter((e) => !e.planned);
  const last = actual[actual.length - 1];
  let status: TrackStatus = actual.length ? 'in_transit' : 'info';
  if (last?.description === DCSA_LABEL.DISC || last?.description === DCSA_LABEL.ARRI) status = 'at_port';
  if (last?.description === DCSA_LABEL.GTOT && actual.some((e) => e.description === DCSA_LABEL.DISC))
    status = 'delivered';
  return {
    found: events.length > 0,
    status: events.length ? status : 'unknown',
    statusText: last ? `${last.description}${last.location ? ` — ${last.location}` : ''}` : '',
    events,
    origin: actual[0]?.location,
    destination: events[events.length - 1]?.location,
    vesselName,
    vesselImo,
    eta,
    departedAt: actual.find((e) => e.description === DCSA_LABEL.DEPA || e.description === DCSA_LABEL.LOAD)?.at ?? null,
    arrivedAt: status === 'delivered' || status === 'at_port' ? (last?.at ?? null) : null,
    source,
  };
}

export async function trackMaersk(number: string, kind: 'container' | 'bl'): Promise<TrackResult | null> {
  if (!config.MAERSK_API_KEY) return null;
  const param = kind === 'container' ? 'equipmentReference' : 'transportDocumentReference';
  const json = await getJson(
    `https://api.maersk.com/track-and-trace-private/events?${param}=${encodeURIComponent(number)}`,
    { headers: { 'Consumer-Key': config.MAERSK_API_KEY, accept: 'application/json' } },
  );
  if (json == null) return { found: false, status: 'unknown', statusText: '', events: [], source: 'api:maersk' };
  return parseDcsaEvents(json, 'api:maersk');
}

// ── 17TRACK ──────────────────────────────────────────────────────────────────

const T17_BASE = 'https://api.17track.net/track/v2.4';
/** 17TRACK rejection codes (API docs, "Error codes"). */
const T17_NOT_REGISTERED = -18019902;

/** 17TRACK main status (+ sub-status) → hub status. */
export function t17Status(status: string, subStatus = ''): TrackStatus {
  if (/customs/i.test(subStatus)) return 'customs';
  switch (status) {
    case 'InfoReceived':
      return 'info';
    case 'InTransit':
      return 'in_transit';
    case 'AvailableForPickup':
    case 'OutForDelivery':
      return 'out_for_delivery';
    case 'Delivered':
      return 'delivered';
    case 'DeliveryFailure':
    case 'Exception':
      return 'exception';
    default:
      return 'unknown'; // NotFound / Expired
  }
}

const place = (a: Obj): string => [str(a.city), str(a.state), str(a.country)].filter(Boolean).join(', ');

/** Parse one `accepted[]` entry of /gettrackinfo. */
export function parseT17(entry: unknown): TrackResult {
  const info = obj(obj(entry).track_info);
  const latest = obj(info.latest_status);
  const status = t17Status(str(latest.status), str(latest.sub_status));
  const events: TrackEventIn[] = [];
  const seen = new Set<string>();
  for (const p of arr(obj(info.tracking).providers).map(obj)) {
    for (const e of arr(p.events).map(obj)) {
      const at = toIso(e.time_utc) ?? toIso(e.time_iso);
      const description = str(e.description);
      const location = str(e.location) || place(obj(e.address));
      const key = `${at}|${location}|${description}`;
      if (!description || seen.has(key)) continue;
      seen.add(key);
      events.push({ at, location, description });
    }
  }
  events.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const ship = obj(info.shipping_info);
  const edd = obj(obj(info.time_metrics).estimated_delivery_date);
  const last = events[events.length - 1];
  const found = status !== 'unknown' || events.length > 0;
  return {
    found,
    status: found && status === 'unknown' ? 'in_transit' : status,
    statusText: last ? last.description : '',
    events,
    origin: place(obj(ship.shipper_address)) || events[0]?.location,
    destination: place(obj(ship.recipient_address)),
    eta: toIso(edd.to) ?? toIso(edd.from),
    departedAt: events[0]?.at ?? null,
    arrivedAt: status === 'delivered' ? (last?.at ?? null) : null,
    source: 'api:17track',
  };
}

async function t17(path: string, body: unknown): Promise<Obj> {
  return obj(
    await getJson(`${T17_BASE}/${path}`, {
      method: 'POST',
      headers: { '17token': config.TRACK17_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Track a parcel through 17TRACK. Reads first and registers only when 17TRACK
 * says the number is not registered yet — registration is what costs quota, so
 * every number is paid for once, however often the cron re-checks it.
 */
export async function track17(number: string): Promise<TrackResult | null> {
  if (!config.TRACK17_API_KEY) return null;
  const empty = (note: string): TrackResult => ({
    found: false,
    status: 'unknown',
    statusText: '',
    events: [],
    source: 'api:17track',
    note,
  });
  const read = obj((await t17('gettrackinfo', [{ number }])).data);
  const accepted = arr(read.accepted)[0];
  if (accepted) return parseT17(accepted);
  const err = obj(obj(arr(read.rejected)[0]).error);
  if (Number(err.code) !== T17_NOT_REGISTERED) {
    return empty(`17TRACK: ${str(err.message) || 'номер відхилено'}`);
  }
  const reg = obj((await t17('register', [{ number }])).data);
  if (!arr(reg.accepted).length) {
    const e = obj(obj(arr(reg.rejected)[0]).error);
    return empty(`17TRACK: ${str(e.message) || 'не вдалося зареєструвати номер'}`);
  }
  return empty('17TRACK: номер поставлено на відстеження, дані зʼявляться за кілька хвилин');
}
