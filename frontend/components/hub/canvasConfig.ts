"use client";
import L from "leaflet";
import { type HubPort, type Track, effEta, etaShiftDays, delayDays, type LatLng, effDeparted } from "@/lib/hub";
import { type EtaBadge } from "./mapIcons";
import { splitAt, smoothPath } from "./geo";

export type BasemapKey = "auto" | "streets" | "light" | "dark" | "satellite" | "terrain" | "ocean";

interface Basemap {
  key: BasemapKey;
  label: string;
  swatch: string;
  url: string;
  attribution: string;
  maxZoom: number;
}

const ESRI = "Tiles © Esri";

/** Map styles the logist can switch between (persisted per browser). */
export const BASEMAPS: Basemap[] = [
  { key: "auto", label: "Авто (за темою)", swatch: "linear-gradient(135deg,#e9eef5 50%,#2a2d33 50%)", url: "", attribution: "", maxZoom: 18 },
  {
    key: "streets",
    label: "Вулиці",
    swatch: "#f2efe6",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: `${ESRI} — Esri, HERE, Garmin, © OpenStreetMap contributors`,
    maxZoom: 18,
  },
  {
    key: "light",
    label: "Світла мінімал",
    swatch: "#f5f5f3",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: `${ESRI} — Esri, HERE, Garmin, © OpenStreetMap contributors`,
    maxZoom: 16,
  },
  {
    key: "dark",
    label: "Темна мінімал",
    swatch: "#1d1f24",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: `${ESRI} — Esri, HERE, Garmin, © OpenStreetMap contributors`,
    maxZoom: 16,
  },
  {
    key: "satellite",
    label: "Супутник",
    swatch: "linear-gradient(135deg,#2f4a2b,#1c3b5a)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: `${ESRI} — Maxar, Earthstar Geographics`,
    maxZoom: 18,
  },
  {
    key: "terrain",
    label: "Рельєф",
    swatch: "linear-gradient(135deg,#d9e4c4,#c7b48e)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: `${ESRI} — Esri, HERE, Garmin, USGS`,
    maxZoom: 18,
  },
  {
    key: "ocean",
    label: "Океан",
    swatch: "linear-gradient(135deg,#9cc3e0,#d7e6ef)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: `${ESRI} — GEBCO, NOAA, National Geographic`,
    maxZoom: 13,
  },
];
export const BASEMAP_STORE = "hub-basemap";

export const TILE_LIGHT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
export const TILE_DARK =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
export const ATTRIB = "Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors · AIS © aisstream.io";

export const FIT_BOUNDS: L.LatLngBoundsExpression = [
  [58, -14],
  [0, 124],
];
export const POLL_MS = 60_000;
export const PORTS_POLL_MS = 5 * 60_000;
export const GLIDE_MS = 1400;
/** Never dead-reckon an AIS vessel further than this past its last fix. */
export const MAX_DR_MS = 20 * 60_000;
/** Ambient AIS clutters a world view — show it from regional zoom. */
export const AIS_MIN_ZOOM = 4;
/** Ports are grouped into count bubbles below this zoom. */
export const CLUSTER_MAX_ZOOM = 6;
/** Permanent name labels from this zoom. */
export const LABEL_MIN_ZOOM = 7;

const STATUS_RANK: Record<string, number> = { closed: 0, disrupted: 1, congested: 2, ok: 3 };
export function statusRank(p: HubPort): number {
  return p.status ? (STATUS_RANK[p.status.status] ?? 4) : 5;
}

/** Days-to-ETA badge for a moving item; red when the ETA slipped or passed. */
export function etaBadge(t: Track, now: number): EtaBadge | null {
  const eta = effEta(t);
  if (!eta || ["delivered", "pending", "unknown", "exception"].includes(t.status)) return null;
  const days = Math.ceil((new Date(eta).getTime() - now) / 86_400_000);
  const late = etaShiftDays(t) >= 1 || days < 0 || (delayDays(t) ?? 0) >= 1;
  const text = days < 0 ? `+${-days} дн` : days === 0 ? "сьогодні" : `${days} дн`;
  return { text, late };
}

/**
 * Where the route estimate puts an item on a given day: before departure at the
 * origin, after the ETA at the destination, in between along its lane. Items
 * without a route or dates stay where they are.
 */
export function positionOn(t: Track, day: string): { point: LatLng; heading: number } | null {
  const path = t.live?.path ?? [];
  const dep = effDeparted(t);
  const eta = effEta(t);
  if (path.length < 2) return null;
  if (t.status === "delivered") return { point: path[path.length - 1]!, heading: 0 };
  if (!dep || !eta) return null;
  const t0 = Date.parse(dep);
  const t1 = Date.parse(eta);
  if (!(t1 > t0)) return null;
  const f = Math.max(0, Math.min(1, (Date.parse(`${day}T12:00:00Z`) - t0) / (t1 - t0)));
  return splitAt(smoothPath(path), f);
}

export type LayerKey = "tracks" | "routes" | "ais" | "ports" | "lanes" | "risk";
export type Tab = "tracks" | "ports" | "lines" | "routes";

export const TABS: { key: Tab; label: string }[] = [
  { key: "tracks", label: "Вантажі" },
  { key: "ports", label: "Порти" },
  { key: "lines", label: "Лінії" },
  { key: "routes", label: "Маршрути" },
];

export const LAYERS: { key: LayerKey; label: string; dot: string }[] = [
  { key: "tracks", label: "Вантажі", dot: "var(--accent)" },
  { key: "routes", label: "Маршрути", dot: "var(--accent)" },
  { key: "ais", label: "Судна AIS", dot: "#0f9b8e" },
  { key: "ports", label: "Порти", dot: "var(--ok)" },
  { key: "lanes", label: "Коридори ліній", dot: "var(--warn)" },
  { key: "risk", label: "Зони воєнного ризику", dot: "var(--err)" },
];

export function resolveCssColor(v: string): string {
  if (typeof document === "undefined" || !v.startsWith("var(")) return v;
  const name = v.slice(4, -1).trim();
  return getComputedStyle(document.body).getPropertyValue(name).trim() || "#2f6feb";
}
