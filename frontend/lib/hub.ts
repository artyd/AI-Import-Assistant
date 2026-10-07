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
