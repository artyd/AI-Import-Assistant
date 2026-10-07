// Logistics hub — wire types + small helpers. Contract: API_CONTRACT.md
// "Logistics hub". All paths relative (/api/hub/...).

import { api } from "@/lib/api";

export type HubMode = "sea" | "air" | "courier" | "domestic";
export type TrackKind = "container" | "bl" | "awb" | "parcel";
export type TrackStatus =
  | "pending"
  | "info"
  | "in_transit"
  | "at_port"
  | "customs"
  | "out_for_delivery"
  | "delivered"
  | "exception"
  | "unknown";

export type LatLng = [number, number];
export type PositionSource = "ais" | "estimate" | "event" | "origin" | "destination";

export interface LiveInfo {
  id: string;
  pos: LatLng | null;
  heading: number;
  path: LatLng[];
  progress: number;
  positionSource: PositionSource | null;
  vessel: { name: string; sog: number | null; updatedAt: string } | null;
}

export interface Track {
  id: string;
  number: string;
  kind: TrackKind;
  carrier: string;
  carrierName: string;
  mode: HubMode;
  label: string;
  status: TrackStatus;
  statusLabel: string;
  statusText: string;
  origin: string;
  destination: string;
  originPos: LatLng | null;
  destPos: LatLng | null;
  vesselName: string;
  vesselImo: string;
  departedAt: string | null;
  eta: string | null;
  firstEta: string | null;
  arrivedAt: string | null;
  source: string;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  lastError: string;
  workspaceId: string | null;
  workspaceNumber: string | null;
  trackUrl: string | null;
  createdAt: string;
  live?: LiveInfo;
}

export interface TrackEvent {
  id: string;
  at: string | null;
  location: string;
  lat: number | null;
  lng: number | null;
  description: string;
  planned: boolean;
}

export interface AmbientVessel {
  mmsi: string;
  name: string;
  lat: number;
  lng: number;
  cog: number | null;
  sog: number | null;
  type: number | null;
}

export interface LiveSnapshot {
  items: Track[];
  vessels: AmbientVessel[];
  serverTime: string;
}

export interface DetectCandidate {
  carrier: string;
  carrierName: string;
  kind: TrackKind;
  mode: HubMode;
  confidence: number;
}

export interface CarrierRef {
  id: string;
  name: string;
  mode: HubMode;
}

export interface TrackingSuggestion {
  number: string;
  carrier: string;
  carrierName: string;
  kind: TrackKind;
  mode: HubMode;
  files: string[];
}

export const MODE_LABEL: Record<HubMode, string> = {
  sea: "Море",
  air: "Авіа",
  courier: "Курʼєр",
  domestic: "Україна",
};

export const KIND_LABEL: Record<TrackKind, string> = {
  container: "контейнер",
  bl: "коносамент",
  awb: "AWB",
  parcel: "відправлення",
};

/** CSS colour token per status (used for pills, rings, route lines). */
export function statusColor(s: TrackStatus): string {
  switch (s) {
    case "delivered":
      return "var(--ok)";
    case "exception":
      return "var(--err)";
    case "at_port":
    case "customs":
      return "var(--warn)";
    case "in_transit":
    case "out_for_delivery":
      return "var(--accent)";
    default:
      return "var(--muted)";
  }
}

export const POSITION_LABEL: Record<PositionSource, string> = {
  ais: "AIS — реальна позиція судна",
  estimate: "Орієнтовно: розраховано за датою відходу та ETA",
  event: "За останньою подією перевізника",
  origin: "Ще у пункті відправлення",
  destination: "У пункті призначення",
};

export function sourceLabel(source: string): string {
  if (source.startsWith("api:")) return `API · ${source.slice(4)}`;
  if (source.startsWith("scrape:")) return `Сайт перевізника · ${source.slice(7)}`;
  return "Немає джерела";
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "ще не перевірялось";
  const m = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "щойно";
  if (m < 60) return `${m} хв тому`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} год тому`;
  return `${Math.round(h / 24)} дн тому`;
}

export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : { year: "numeric" }),
  });
}

/** Days between the first and current ETA (positive = later). */
export function etaShiftDays(t: Pick<Track, "eta" | "firstEta">): number {
  if (!t.eta || !t.firstEta) return 0;
  return Math.round((new Date(t.eta).getTime() - new Date(t.firstEta).getTime()) / 86_400_000);
}

export const hubApi = {
  live: () => api<LiveSnapshot>("/api/hub/live"),
  detect: (number: string) =>
    api<{ normalized: string; candidates: DetectCandidate[] }>(
      `/api/hub/detect?number=${encodeURIComponent(number)}`
    ),
  carriers: () => api<{ carriers: CarrierRef[] }>("/api/hub/carriers"),
  add: (body: { number: string; carrier?: string; label?: string; workspaceId?: string | null }) =>
    api<{ track: Track; events: TrackEvent[] }>("/api/hub/tracks", { method: "POST", body }),
  get: (id: string) => api<{ track: Track; events: TrackEvent[] }>(`/api/hub/tracks/${id}`),
  patch: (
    id: string,
    body: { label?: string; workspaceId?: string | null; carrier?: string; archived?: boolean }
  ) => api<{ track: Track; events: TrackEvent[] }>(`/api/hub/tracks/${id}`, { method: "PATCH", body }),
  remove: (id: string) => api<void>(`/api/hub/tracks/${id}`, { method: "DELETE" }),
  refresh: (id: string) =>
    api<{ track: Track; events: TrackEvent[] }>(`/api/hub/tracks/${id}/refresh`, { method: "POST" }),
  suggestions: (workspaceId: string) =>
    api<{ suggestions: TrackingSuggestion[] }>(`/api/workspaces/${workspaceId}/tracking-suggestions`),
};

// ── Phase 2: ports / airports / crossings ────────────────────────────────────

export type PlaceKind = "sea" | "air" | "customs" | "inland";
export type PortStatus = "ok" | "congested" | "disrupted" | "closed";

export interface PortStatusInfo {
  markId: string;
  status: PortStatus;
  label: string;
  note: string;
  by: "ai" | "user";
  userName: string;
  sourceUrl: string;
  sourceTitle: string;
  confidence: number | null;
  updatedAt: string;
  confirmations: number;
}

export interface HubPort {
  code: string;
  name: string;
  nameEn: string;
  country: string;
  lat: number;
  lng: number;
  kind: PlaceKind;
  favorite: boolean;
  trackCount: number;
  status: PortStatusInfo | null;
}

export interface PortMark {
  id: string;
  status: PortStatus;
  label: string;
  note: string;
  by: "ai" | "user";
  userName: string;
  sourceUrl: string;
  sourceTitle: string;
  createdAt: string;
  validUntil: string;
  confirmations: number;
}

export interface PortDetailData {
  port: HubPort;
  history: PortMark[];
  tracks: { id: string; number: string; label: string; status: TrackStatus; eta: string | null }[];
}

export const PORT_STATUS_LABEL: Record<PortStatus, string> = {
  ok: "Працює",
  congested: "Черги / перевантаження",
  disrupted: "Збої в роботі",
  closed: "Закрито",
};

export const PLACE_KIND_LABEL: Record<PlaceKind, string> = {
  sea: "Морський порт",
  air: "Аеропорт",
  customs: "Пункт пропуску",
  inland: "Хаб / місто",
};

export function portStatusColor(s: PortStatus | null | undefined): string {
  switch (s) {
    case "ok":
      return "var(--ok)";
    case "congested":
      return "var(--warn)";
    case "disrupted":
      return "#e8590c";
    case "closed":
      return "var(--err)";
    default:
      return "var(--faint)";
  }
}

export const portApi = {
  list: () => api<{ ports: HubPort[] }>("/api/hub/ports"),
  get: (code: string) => api<PortDetailData>(`/api/hub/ports/${encodeURIComponent(code)}`),
  mark: (code: string, status: PortStatus, note?: string) =>
    api<PortDetailData>(`/api/hub/ports/${encodeURIComponent(code)}/status`, { method: "POST", body: { status, note } }),
  confirm: (code: string, markId: string) =>
    api<PortDetailData>(`/api/hub/ports/${encodeURIComponent(code)}/status/${markId}/confirm`, { method: "POST" }),
  favorite: (code: string, on: boolean) =>
    api<void>(`/api/hub/ports/${encodeURIComponent(code)}/favorite`, { method: on ? "PUT" : "DELETE" }),
};

// ── Phase 3: sea lines ───────────────────────────────────────────────────────

export type UaStatus = "accepting" | "limited" | "suspended";
export type RedSea = "suez" | "cape" | "mixed";

export interface FieldStatus<T> {
  value: T;
  label?: string;
  markId: string;
  by: "ai" | "user";
  userName: string;
  sourceUrl: string;
  sourceTitle: string;
  note: string;
  updatedAt: string;
  confirmations: number;
}

export interface Reliability {
  delivered: number;
  onTimeShare: number | null;
  avgDelayDays: number | null;
  inTransit: number;
}

export interface CarrierSummary {
  id: string;
  name: string;
  uaStatus: FieldStatus<UaStatus> | null;
  redSea: FieldStatus<RedSea> | null;
  warRisk: FieldStatus<string> | null;
  reliability: Reliability;
  updatedAt: string | null;
}

export interface Lane {
  id: string;
  name: string;
  via: "suez" | "cape";
  rotation: { code: string; name: string }[];
  transitDaysMin: number;
  transitDaysMax: number;
  distanceNm: number;
  path: LatLng[];
}

export interface CarrierService {
  id: string;
  carrier: string;
  name: string;
  rotation: { code: string; name: string }[];
  transitDaysMin: number | null;
  transitDaysMax: number | null;
  frequency: string;
  via: "" | "suez" | "cape";
  note: string;
  createdBy: string;
  updatedAt: string;
  path: LatLng[];
}

export interface CarrierMarkHistory {
  id: string;
  uaStatus: UaStatus | null;
  redSea: RedSea | null;
  warRisk: string;
  note: string;
  by: "ai" | "user";
  userName: string;
  sourceUrl: string;
  sourceTitle: string;
  createdAt: string;
}

export interface CarrierDetailData {
  carrier: CarrierSummary;
  services: CarrierService[];
  history: CarrierMarkHistory[];
}

export const UA_STATUS_LABEL: Record<UaStatus, string> = {
  accepting: "Приймає на Україну",
  limited: "Обмежено",
  suspended: "Не приймає",
};
export const RED_SEA_LABEL: Record<RedSea, string> = {
  suez: "Через Суец",
  cape: "В обхід Африки",
  mixed: "Змішано",
};

export function uaColor(s: UaStatus | null | undefined): string {
  return s === "accepting" ? "var(--ok)" : s === "limited" ? "var(--warn)" : s === "suspended" ? "var(--err)" : "var(--faint)";
}

export interface ServiceInputBody {
  name: string;
  rotation: string[];
  transitDaysMin?: number | null;
  transitDaysMax?: number | null;
  frequency?: string;
  via?: "" | "suez" | "cape";
  note?: string;
}

export const lineApi = {
  list: () => api<{ carriers: CarrierSummary[]; lanes: Lane[] }>("/api/hub/lines"),
  get: (id: string) => api<CarrierDetailData>(`/api/hub/lines/${id}`),
  mark: (id: string, body: { uaStatus?: UaStatus | null; redSea?: RedSea | null; warRisk?: string; note?: string }) =>
    api<CarrierDetailData>(`/api/hub/lines/${id}/status`, { method: "POST", body }),
  confirm: (id: string, markId: string) =>
    api<CarrierDetailData>(`/api/hub/lines/${id}/status/${markId}/confirm`, { method: "POST" }),
  addService: (id: string, body: ServiceInputBody) =>
    api<CarrierDetailData>(`/api/hub/lines/${id}/services`, { method: "POST", body }),
  removeService: (id: string, serviceId: string) =>
    api<void>(`/api/hub/lines/${id}/services/${serviceId}`, { method: "DELETE" }),
};

/**
 * War-risk areas — rough outlines of the Joint War Committee listed areas that
 * matter for Ukrainian imports. Indicative only; the UI says so.
 */
export const RISK_ZONES: { id: string; name: string; note: string; color: string; polygon: LatLng[] }[] = [
  {
    id: "red-sea",
    name: "Червоне море / Аденська затока",
    color: "#ff2d2d",
    note: "Атаки на судна; лінії можуть іти в обхід Африки (+10–14 діб) і брати надбавки.",
    polygon: [
      [27.75, 34.25],
      [27.25, 33.85],
      [26.1, 34.3],
      [23.95, 35.5],
      [22.0, 36.9],
      [19.6, 37.25],
      [18.0, 38.5],
      [15.6, 39.5],
      [14.6, 40.8],
      [13.4, 41.9],
      [12.7, 43.1],
      [11.6, 43.15],
      [11.4, 43.6],
      [10.45, 44.9],
      [10.9, 46.6],
      [11.3, 49.2],
      [11.8, 51.2],
      [12.2, 53.5],
      [15.3, 52.2],
      [14.5, 49.1],
      [13.5, 46.6],
      [12.8, 45.0],
      [12.65, 43.55],
      [13.3, 43.25],
      [14.8, 42.95],
      [16.9, 42.55],
      [18.2, 41.5],
      [20.0, 40.2],
      [21.5, 39.15],
      [24.05, 38.05],
      [25.3, 37.2],
      [26.8, 36.0],
      [27.9, 35.2],
      [28.0, 34.5],
    ],
  },
  {
    id: "black-sea",
    name: "Північ Чорного моря",
    color: "#ff6a00",
    note: "Зона воєнного ризику: страхові надбавки, обмеження заходів у порти.",
    polygon: [
      [45.2, 29.75],
      [45.45, 29.7],
      [46.0, 30.3],
      [46.45, 30.75],
      [46.6, 31.05],
      [46.6, 31.55],
      [46.2, 31.9],
      [46.12, 32.9],
      [45.95, 33.35],
      [45.4, 32.55],
      [45.2, 33.35],
      [44.6, 33.45],
      [44.45, 34.15],
      [44.85, 35.1],
      [45.05, 35.45],
      [45.3, 36.45],
      [45.2, 36.7],
      [44.9, 37.3],
      [44.7, 37.8],
      [44.1, 39.05],
      [43.55, 39.75],
      [43.0, 39.4],
      [42.9, 35.5],
      [43.2, 31.8],
      [44.0, 30.1],
      [44.9, 29.75],
    ],
  },
  {
    id: "gulf",
    name: "Перська затока / Ормузька протока",
    color: "#e0115f",
    note: "Підвищений ризик для суден; уточнюйте надбавки у лінії.",
    polygon: [
      [29.95, 48.55],
      [29.3, 48.05],
      [28.0, 48.65],
      [27.0, 49.65],
      [26.25, 50.15],
      [25.6, 50.75],
      [26.15, 51.25],
      [25.3, 51.6],
      [24.3, 52.6],
      [24.5, 54.4],
      [25.25, 55.3],
      [25.8, 56.0],
      [26.4, 56.35],
      [27.1, 56.4],
      [26.75, 55.3],
      [26.55, 54.6],
      [27.3, 52.6],
      [28.0, 51.3],
      [28.95, 50.85],
      [29.6, 50.2],
      [30.0, 49.1],
    ],
  },
];

// ── Phase 4: route builder ───────────────────────────────────────────────────

export type RouteMode = "sea" | "air" | "road" | "rail" | "customs";
export type LegState = "planned" | "in_progress" | "done" | "no_data";

export interface RoutePoint {
  code: string;
  name: string;
  pos: LatLng | null;
}

export interface LegComputed {
  id: string;
  path: LatLng[];
  distanceKm: number;
  plannedDeparture: string | null;
  plannedArrival: string | null;
  estimatedDays: number;
  datesEstimated: boolean;
  fact: { state: LegState; departedAt: string | null; arrivedAt: string | null; eta: string | null; path: LatLng[] } | null;
  projectedDeparture: string | null;
  projectedArrival: string | null;
  delayDays: number;
  freeTime: {
    freeDays: number;
    startsAt: string | null;
    endsAt: string | null;
    daysLeft: number | null;
    overDays: number;
    demurrageCost: number;
    currency: string;
  } | null;
}

export interface RouteLeg {
  id: string;
  seq: number;
  mode: RouteMode;
  from: RoutePoint;
  to: RoutePoint;
  carrier: string;
  carrierName: string;
  via: "" | "suez" | "cape";
  trackedId: string | null;
  tracked: { id: string; number: string; label: string; status: TrackStatus } | null;
  plannedDeparture: string | null;
  plannedArrival: string | null;
  costAmount: number | null;
  costCurrency: string;
  freeDays: number | null;
  demurragePerDay: number | null;
  notes: string;
  computed: LegComputed;
}

export type RouteHealth = "draft" | "on_track" | "delayed" | "at_risk" | "done";

export interface PlannedRoute {
  id: string;
  name: string;
  status: "draft" | "active" | "done";
  notes: string;
  workspaceId: string | null;
  workspaceNumber: string | null;
  createdAt: string;
  updatedAt: string;
  summary: {
    distanceKm: number;
    plannedStart: string | null;
    plannedEnd: string | null;
    projectedEnd: string | null;
    delayDays: number;
    costs: Record<string, number>;
    demurrage: Record<string, number>;
    health: RouteHealth;
  };
  legs: RouteLeg[];
}

export interface LegDraft {
  mode: RouteMode;
  from: { code?: string; name?: string; lat?: number; lng?: number };
  to?: { code?: string; name?: string; lat?: number; lng?: number };
  carrier?: string;
  via?: "" | "suez" | "cape";
  trackedId?: string | null;
  plannedDeparture?: string | null;
  plannedArrival?: string | null;
  costAmount?: number | null;
  costCurrency?: string;
  freeDays?: number | null;
  demurragePerDay?: number | null;
  notes?: string;
}

export interface RouteDraft {
  name: string;
  workspaceId?: string | null;
  status?: "draft" | "active" | "done";
  notes?: string;
  legs: LegDraft[];
}

export interface RouteVariant {
  title: string;
  summary: string;
  costLevel: "low" | "medium" | "high";
  risks: string[];
  pros: string[];
  cons: string[];
  totalDays: number;
  arrival: string;
  legs: (LegDraft & { estimatedDays: number; fromName: string; toName: string; carrierName: string })[];
}

export const ROUTE_MODE_LABEL: Record<RouteMode, string> = {
  sea: "Море",
  air: "Авіа",
  road: "Авто",
  rail: "Залізниця",
  customs: "Митниця",
};
export const ROUTE_MODE_ICON: Record<RouteMode, string> = { sea: "🚢", air: "✈️", road: "🚚", rail: "🚆", customs: "🛃" };
export const ROUTE_MODE_COLOR: Record<RouteMode, string> = {
  sea: "#2f6feb",
  air: "#7c3aed",
  road: "#12936a",
  rail: "#8a5a2b",
  customs: "#d98213",
};

export const HEALTH_LABEL: Record<RouteHealth, string> = {
  draft: "Чернетка",
  on_track: "За планом",
  delayed: "Затримка",
  at_risk: "Під ризиком",
  done: "Завершено",
};
export function healthColor(h: RouteHealth): string {
  return h === "on_track" || h === "done" ? "var(--ok)" : h === "delayed" ? "var(--warn)" : h === "at_risk" ? "var(--err)" : "var(--muted)";
}

export function money(map: Record<string, number>): string {
  const parts = Object.entries(map).map(([c, v]) => `${Math.round(v).toLocaleString("uk-UA")} ${c}`);
  return parts.length ? parts.join(" + ") : "—";
}

export const routeApi = {
  list: () => api<{ routes: PlannedRoute[] }>("/api/hub/routes"),
  get: (id: string) => api<{ route: PlannedRoute }>(`/api/hub/routes/${id}`),
  create: (body: RouteDraft) => api<{ route: PlannedRoute }>("/api/hub/routes", { method: "POST", body }),
  update: (id: string, body: RouteDraft) => api<{ route: PlannedRoute }>(`/api/hub/routes/${id}`, { method: "PUT", body }),
  remove: (id: string) => api<void>(`/api/hub/routes/${id}`, { method: "DELETE" }),
  suggest: (body: { from: string; to: string; readyDate?: string; cargo?: string; priority?: "cost" | "speed" | "reliability" }) =>
    api<{ from: { code: string; name: string }; to: { code: string; name: string }; readyDate: string; variants: RouteVariant[] }>(
      "/api/hub/routes/suggest",
      { method: "POST", body }
    ),
};
