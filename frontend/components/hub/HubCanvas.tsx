"use client";

// Логістичний хаб — the live map. Everything a logist tracks (containers, B/L,
// AWB, couriers, Нова Пошта/Укрпошта) on one map: markers glide between
// updates, in-transit items creep along their sea lane / air arc by elapsed time,
// AIS vessels around the Black Sea drift by their reported course and speed.
// The left panel adds/lists tracks, the right card shows one item's timeline.
//
// Statically imports Leaflet → must only load client-side (MapView wraps it in
// dynamic(ssr:false)). Map layers are managed imperatively for smooth motion.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import {
  hubApi,
  lineApi,
  routeApi,
  ROUTE_MODE_COLOR,
  portApi,
  RISK_ZONES,
  portStatusColor,
  statusColor,
  type AmbientVessel,
  type CarrierDetailData,
  type CarrierRef,
  type LegDraft,
  type PlannedRoute,
  type CarrierSummary,
  type Lane,
  type HubPort,
  type LatLng,
  type LiveSnapshot,
  type Track,
} from "@/lib/hub";
import { IconSpinner } from "@/components/icons";
import { aisIcon, endpointIcon, glyphRotates, HUB_MAP_CSS, HUB_PORT_CSS, portIcon, setRotation, trackIcon } from "./mapIcons";
import { advance, lerp, smoothPath, splitAt } from "./geo";
import { TracksPanel, type WorkspaceRef } from "./TracksPanel";
import { TrackDetail } from "./TrackDetail";
import { isIssue, PortsPanel } from "./PortsPanel";
import { PortDetail } from "./PortDetail";
import { LinesPanel } from "./LinesPanel";
import { CarrierDetail } from "./CarrierDetail";
import { RoutesPanel } from "./RoutesPanel";
import { RouteDetail, type PickedPoint } from "./RouteDetail";
import { haversineKm } from "./geo";

type BasemapKey = "auto" | "streets" | "light" | "dark" | "satellite" | "terrain" | "ocean";

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
const BASEMAPS: Basemap[] = [
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
const BASEMAP_STORE = "hub-basemap";

const TILE_LIGHT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const TILE_DARK =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const ATTRIB = "Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors · AIS © aisstream.io";

const FIT_BOUNDS: L.LatLngBoundsExpression = [
  [58, -14],
  [0, 124],
];
const POLL_MS = 60_000;
const PORTS_POLL_MS = 5 * 60_000;
const GLIDE_MS = 1400;
/** Never dead-reckon an AIS vessel further than this past its last fix. */
const MAX_DR_MS = 20 * 60_000;
/** Ambient AIS clutters a world view — show it from regional zoom. */
const AIS_MIN_ZOOM = 4;

type LayerKey = "tracks" | "routes" | "ais" | "ports" | "lanes" | "risk";
type Tab = "tracks" | "ports" | "lines" | "routes";

const TABS: { key: Tab; label: string }[] = [
  { key: "tracks", label: "Вантажі" },
  { key: "ports", label: "Порти" },
  { key: "lines", label: "Лінії" },
  { key: "routes", label: "Маршрути" },
];

const LAYERS: { key: LayerKey; label: string; dot: string }[] = [
  { key: "tracks", label: "Вантажі", dot: "var(--accent)" },
  { key: "routes", label: "Маршрути", dot: "var(--accent)" },
  { key: "ais", label: "Судна AIS", dot: "#0f9b8e" },
  { key: "ports", label: "Порти", dot: "var(--ok)" },
  { key: "lanes", label: "Коридори ліній", dot: "var(--warn)" },
  { key: "risk", label: "Зони воєнного ризику", dot: "var(--err)" },
];

interface TrackAnim {
  marker: L.Marker;
  from: LatLng;
  to: LatLng;
  start: number;
  heading: number;
  item: Track;
  iconKey: string;
}

interface AisAnim {
  marker: L.Marker;
  base: LatLng;
  baseAt: number;
  v: AmbientVessel;
}

function resolveCssColor(v: string): string {
  if (typeof document === "undefined" || !v.startsWith("var(")) return v;
  const name = v.slice(4, -1).trim();
  return getComputedStyle(document.body).getPropertyValue(name).trim() || "#2f6feb";
}

export function HubCanvas({ workspaceId }: { workspaceId?: string }) {
  const { theme } = useTheme();
  const [map, setMap] = useState<L.Map | null>(null);
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [ports, setPorts] = useState<HubPort[]>([]);
  const [tab, setTab] = useState<Tab>("tracks");
  const [selPort, setSelPort] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    tracks: true,
    routes: true,
    ais: true,
    ports: true,
    lanes: false,
    risk: true,
  });
  const [carriers, setCarriers] = useState<CarrierSummary[]>([]);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [selCarrier, setSelCarrier] = useState<string | null>(null);
  const [selLane, setSelLane] = useState<string | null>(null);
  const [carrierDetail, setCarrierDetail] = useState<CarrierDetailData | null>(null);
  const [routes, setRoutes] = useState<PlannedRoute[]>([]);
  const [selRoute, setSelRoute] = useState<string | null>(null);
  const [draftLegs, setDraftLegs] = useState<LegDraft[] | null>(null);
  const [carrierRefs, setCarrierRefs] = useState<CarrierRef[]>([]);
  const [picking, setPicking] = useState(false);
  const pickRef = useRef<((p: PickedPoint) => void) | null>(null);
  const [isFull, setIsFull] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [narrow, setNarrow] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [zoom, setZoom] = useState(3);
  const [wrapW, setWrapW] = useState(1200);
  const [basemap, setBasemap] = useState<BasemapKey>("auto");

  useEffect(() => {
    try {
      const v = localStorage.getItem(BASEMAP_STORE) as BasemapKey | null;
      if (v && BASEMAPS.some((b) => b.key === v)) setBasemap(v);
    } catch {
      /* storage unavailable — keep auto */
    }
  }, []);
  const chooseBasemap = useCallback((k: BasemapKey) => {
    setBasemap(k);
    try {
      localStorage.setItem(BASEMAP_STORE, k);
    } catch {
      /* ignore */
    }
  }, []);

  const wrapRef = useRef<HTMLDivElement>(null);
  const trackAnims = useRef(new Map<string, TrackAnim>());
  const aisAnims = useRef(new Map<string, AisAnim>());
  const routeLayer = useRef<L.LayerGroup | null>(null);
  const portLayer = useRef<L.LayerGroup | null>(null);
  const lineLayer = useRef<L.LayerGroup | null>(null);
  const planLayer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const snapAt = useRef(Date.now());

  const items = useMemo(() => snap?.items ?? [], [snap]);
  const selected = items.find((t) => t.id === selectedId) ?? null;

  // ── Data ─────────────────────────────────────────────────────────────────
  const reload = useCallback(async (selectId?: string) => {
    try {
      const s = await hubApi.live();
      snapAt.current = Date.now();
      setSnap(s);
      setError(null);
      if (selectId) setSelectedId(selectId);
    } catch {
      setError("Не вдалося завантажити дані хабу.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  const loadPorts = useCallback(() => {
    portApi
      .list()
      .then((r) => setPorts(r.ports ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadPorts();
    const t = setInterval(loadPorts, PORTS_POLL_MS);
    return () => clearInterval(t);
  }, [loadPorts]);

  const loadLines = useCallback(() => {
    lineApi
      .list()
      .then((r) => {
        setCarriers(r.carriers ?? []);
        setLanes(r.lanes ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadLines();
    const t = setInterval(loadLines, PORTS_POLL_MS);
    return () => clearInterval(t);
  }, [loadLines]);

  const loadRoutes = useCallback(() => {
    routeApi
      .list()
      .then((r) => setRoutes(r.routes ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadRoutes();
    hubApi
      .carriers()
      .then((r) => setCarrierRefs(r.carriers))
      .catch(() => {});
    const t = setInterval(loadRoutes, POLL_MS);
    return () => clearInterval(t);
  }, [loadRoutes]);

  const setPick = useCallback((cb: ((p: PickedPoint) => void) | null) => {
    pickRef.current = cb;
    setPicking(!!cb);
  }, []);

  const selectTrack = useCallback((id: string | null) => {
    setSelPort(null);
    setSelCarrier(null);
    setSelRoute(null);
    setSelectedId(id);
  }, []);
  const selectRoute = useCallback((id: string | null) => {
    setSelectedId(null);
    setSelPort(null);
    setSelCarrier(null);
    setSelRoute(id);
  }, []);
  const selectPort = useCallback((code: string | null) => {
    setSelectedId(null);
    setSelCarrier(null);
    setSelRoute(null);
    setSelPort(code);
  }, []);
  const selectCarrier = useCallback((id: string | null) => {
    setSelectedId(null);
    setSelPort(null);
    setSelRoute(null);
    setCarrierDetail(null);
    setSelCarrier(id);
  }, []);
  const selectedPort = ports.find((p) => p.code === selPort) ?? null;

  useEffect(() => {
    api<{ workspaces: WorkspaceRef[] }>("/api/workspaces")
      .then((r) => setWorkspaces(r.workspaces ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    const mq = window.matchMedia("(max-width: 760px)");
    const onMq = () => setNarrow(mq.matches);
    onMq();
    mq.addEventListener("change", onMq);
    return () => {
      clearInterval(t);
      mq.removeEventListener("change", onMq);
    };
  }, []);

  // Track the canvas width so the HUD can go compact when space is tight.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth));
    ro.observe(el);
    setWrapW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // On phones the list and the detail card share the screen — one at a time.
  useEffect(() => {
    if (narrow && (selectedId || selPort || selCarrier || selRoute)) setPanelOpen(false);
  }, [narrow, selectedId, selPort, selCarrier, selRoute]);

  // ── Route plan: planned legs (dashed, by mode) + actual tracked path ──────
  const selectedRoute = routes.find((r) => r.id === selRoute) ?? null;
  useEffect(() => {
    const g = planLayer.current;
    if (!map || !g) return;
    g.clearLayers();
    const portPos = (p: { code?: string; lat?: number; lng?: number } | undefined): [number, number] | null => {
      if (!p) return null;
      if (p.code) {
        const x = ports.find((q) => q.code === p.code);
        return x ? [x.lat, x.lng] : null;
      }
      return p.lat != null && p.lng != null ? [p.lat, p.lng] : null;
    };
    const stop = (pos: [number, number], n: number, color: string, title: string) =>
      L.marker(pos, {
        icon: L.divIcon({
          className: "",
          html: `<span style="display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:${color};color:#fff;font:700 11px/1 var(--font-sans);box-shadow:0 0 0 2px var(--surface),0 2px 6px rgba(0,0,0,.3)">${n}</span>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        }),
      })
        .bindTooltip(title, { direction: "top" })
        .addTo(g);
    if (draftLegs) {
      draftLegs.forEach((l, i) => {
        const a = portPos(l.from);
        const b = l.mode === "customs" ? a : portPos(l.to);
        const color = ROUTE_MODE_COLOR[l.mode];
        if (a) stop(a, i + 1, color, `${i + 1}. ${l.mode}`);
        if (a && b && l.mode !== "customs") L.polyline(smoothPath([a, b]), { color, weight: 3, opacity: 0.8, dashArray: "6 8" }).addTo(g);
      });
      return;
    }
    if (!selectedRoute) return;
    selectedRoute.legs.forEach((l, i) => {
      const color = ROUTE_MODE_COLOR[l.mode];
      const c = l.computed;
      if (c.path.length > 1) {
        L.polyline(smoothPath(c.path), { color, weight: 4, opacity: 0.55, dashArray: "8 8" })
          .bindTooltip(`План: ${l.from.name} → ${l.to.name}`, { sticky: true })
          .addTo(g);
      }
      if (c.fact && c.fact.path.length > 1) {
        L.polyline(smoothPath(c.fact.path), { color: c.delayDays > 0 ? "#dc4a4f" : color, weight: 5, opacity: 0.95, className: "hub-trail" })
          .bindTooltip("Факт за трекінгом", { sticky: true })
          .addTo(g);
      }
      if (l.from.pos) stop(l.from.pos, i + 1, color, `${i + 1}. ${l.mode === "customs" ? "Митниця · " : ""}${l.from.name}`);
      if (i === selectedRoute.legs.length - 1 && l.to.pos && l.mode !== "customs") stop(l.to.pos, i + 2, "#111", l.to.name);
    });
  }, [map, selectedRoute, draftLegs, ports]);

  useEffect(() => {
    if (!map || !selectedRoute) return;
    const pts = selectedRoute.legs.flatMap((l) => l.computed.path);
    if (pts.length > 1) map.flyToBounds(L.latLngBounds(pts.map((p) => L.latLng(p[0], p[1]))).pad(0.15), { duration: 0.9 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selectedRoute?.id]);

  // Map pick mode for the route builder: nearest gazetteer place, else a point.
  useEffect(() => {
    if (!map) return;
    const onClick = (e: L.LeafletMouseEvent) => {
      const cb = pickRef.current;
      if (!cb) return;
      const p: [number, number] = [e.latlng.lat, e.latlng.lng];
      let best: { code: string; d: number } | null = null;
      for (const q of ports) {
        const d = haversineKm(p, [q.lat, q.lng]);
        if (d < 150 && (!best || d < best.d)) best = { code: q.code, d };
      }
      cb(best ? { code: best.code } : { name: `Точка ${p[0].toFixed(2)}, ${p[1].toFixed(2)}`, lat: p[0], lng: p[1] });
      setPick(null);
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [map, ports, setPick]);

  // ── Lines: reference corridors, war-risk zones, selected carrier's services ──
  useEffect(() => {
    const g = lineLayer.current;
    if (!map || !g) return;
    g.clearLayers();
    if (layers.risk) {
      for (const z of RISK_ZONES) {
        L.polygon(z.polygon, {
          color: z.color,
          weight: 2,
          opacity: 0.95,
          fillColor: z.color,
          fillOpacity: 0.38,
          smoothFactor: 0.5,
        })
          .bindTooltip(`<b>${z.name}</b><br/>${z.note}<br/><span style="opacity:.7">Контури орієнтовні (зони JWC)</span>`, { sticky: true })
          .addTo(g);
      }
    }
    const showLanes = layers.lanes || tab === "lines";
    for (const l of lanes) {
      const sel = l.id === selLane;
      if (!showLanes && !sel) continue;
      const color = l.via === "cape" ? "#d98213" : "#2f6feb";
      L.polyline(smoothPath(l.path), {
        color,
        weight: sel ? 4 : 2,
        opacity: sel ? 0.95 : selLane ? 0.18 : 0.45,
        dashArray: l.via === "cape" ? "8 7" : undefined,
        className: sel ? "hub-ants" : "",
      })
        .bindTooltip(`${l.name} · ${l.transitDaysMin}–${l.transitDaysMax} дн (орієнтовно)`, { sticky: true })
        .on("click", () => {
          setTab("lines");
          setSelLane(l.id);
        })
        .addTo(g);
    }
    for (const s of carrierDetail?.services ?? []) {
      if (s.path.length < 2) continue;
      L.polyline(smoothPath(s.path), { color: "#7c3aed", weight: 4, opacity: 0.9, className: "hub-ants" })
        .bindTooltip(`${s.name}${s.transitDaysMin ? ` · ${s.transitDaysMin}${s.transitDaysMax ? `–${s.transitDaysMax}` : ""} дн` : ""}`, { sticky: true })
        .addTo(g);
      for (const r of s.rotation) {
        const p = ports.find((x) => x.code === r.code);
        if (p) L.circleMarker([p.lat, p.lng], { radius: 4, color: "#fff", weight: 1.5, fillColor: "#7c3aed", fillOpacity: 1 }).bindTooltip(r.name).addTo(g);
      }
    }
  }, [map, lanes, selLane, layers.lanes, layers.risk, tab, carrierDetail, ports]);

  // Frame a selected corridor / carrier services.
  useEffect(() => {
    if (!map || !selLane) return;
    const l = lanes.find((x) => x.id === selLane);
    if (l && l.path.length > 1) map.flyToBounds(L.latLngBounds(l.path.map((p) => L.latLng(p[0], p[1]))).pad(0.15), { duration: 0.9 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selLane]);
  useEffect(() => {
    if (!map || !carrierDetail) return;
    const pts = carrierDetail.services.flatMap((s) => s.path);
    if (pts.length > 1) map.flyToBounds(L.latLngBounds(pts.map((p) => L.latLng(p[0], p[1]))).pad(0.15), { duration: 0.9 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, carrierDetail?.carrier.id]);

  // ── Map setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map) return;
    map.fitBounds(FIT_BOUNDS);
    const scale = L.control.scale({ metric: true, imperial: false, position: "bottomright" });
    scale.addTo(map);
    routeLayer.current = L.layerGroup().addTo(map);
    lineLayer.current = L.layerGroup().addTo(map);
    planLayer.current = L.layerGroup().addTo(map);
    portLayer.current = L.layerGroup().addTo(map);
    const onZoom = () => setZoom(map.getZoom());
    onZoom();
    map.on("zoomend", onZoom);
    return () => {
      map.off("zoomend", onZoom);
      scale.remove();
      routeLayer.current?.remove();
      portLayer.current?.remove();
      lineLayer.current?.remove();
      planLayer.current?.remove();
    };
  }, [map]);

  // Frame the tracked items once they first arrive.
  useEffect(() => {
    if (!map || fitted.current || items.length === 0) return;
    const pts = items.flatMap((t) => (t.live?.pos ? [t.live.pos] : []));
    if (pts.length === 0) return;
    fitted.current = true;
    if (pts.length === 1) map.setView(pts[0]!, 5);
    else {
      // Keep markers clear of the floating panel (left) and the toolbar / HUD.
      const wide = map.getSize().x > 760;
      map.fitBounds(L.latLngBounds(pts.map((p) => L.latLng(p[0], p[1]))), {
        maxZoom: 6,
        paddingTopLeft: [wide ? 370 : 30, 70],
        paddingBottomRight: [40, 80],
      });
    }
  }, [map, items]);

  // ── Ports / airports / crossings, coloured by live status ────────────────
  useEffect(() => {
    const g = portLayer.current;
    if (!map || !g) return;
    g.clearLayers();
    if (!layers.ports) return;
    for (const p of ports) {
      if (p.kind === "inland") continue;
      const issue = isIssue(p);
      const sel = p.code === selPort;
      // Zoomed out, show only what matters: favourites, places with a known
      // status, my destinations. Everything else appears from regional zoom.
      if (zoom < 6 && !sel && !p.favorite && !p.status && p.trackCount === 0) continue;
      const color = resolveCssColor(portStatusColor(p.status?.status));
      L.marker([p.lat, p.lng], {
        icon: portIcon(p.kind, color, p.favorite, p.status?.status === "closed" || p.status?.status === "disrupted", sel),
        zIndexOffset: sel ? 900 : issue ? 300 : p.favorite ? 200 : 0,
        title: p.name,
      })
        .on("click", () => {
          setTab("ports");
          selectPort(p.code);
        })
        .bindTooltip(`${p.name} · ${p.status ? p.status.label : "немає даних"}`, { direction: "top", offset: [0, -10] })
        .addTo(g);
    }
  }, [map, ports, layers.ports, zoom, selPort, selectPort, theme]);

  // ── Route lines (traveled solid + remaining "marching ants") ─────────────
  useEffect(() => {
    const g = routeLayer.current;
    if (!map || !g) return;
    g.clearLayers();
    if (!layers.tracks) return;
    for (const t of items) {
      const path = smoothPath(t.live?.path ?? []);
      const isSel = t.id === selectedId;
      if (path.length < 2 || (!layers.routes && !isSel)) continue;
      const color = resolveCssColor(statusColor(t.status));
      const progress = t.status === "delivered" ? 1 : (t.live?.progress ?? 0);
      const { done, rest } = splitAt(path, progress);
      const w = isSel ? 4 : 2.5;
      const op = isSel ? 0.95 : selectedId ? 0.25 : 0.55;
      if (done.length > 1) L.polyline(done, { color, weight: w, opacity: op, className: isSel ? "hub-trail" : "" }).addTo(g);
      if (rest.length > 1)
        L.polyline(rest, { color, weight: w - 0.5, opacity: op * 0.85, className: "hub-ants", dashArray: "7 9" }).addTo(g);
      if (isSel || layers.routes) {
        if (t.originPos) L.marker(t.originPos, { icon: endpointIcon("origin", color), interactive: false }).addTo(g);
        if (t.destPos)
          L.marker(t.destPos, { icon: endpointIcon("dest", color) })
            .bindTooltip(t.destination || "Пункт призначення", { direction: "top" })
            .addTo(g);
      }
    }
  }, [map, items, selectedId, layers.routes, layers.tracks, theme]);

  // ── Tracked-item markers: create / update / glide ────────────────────────
  useEffect(() => {
    if (!map) return;
    const anims = trackAnims.current;
    const seen = new Set<string>();
    const t0 = performance.now();
    if (layers.tracks) {
      for (const t of items) {
        const pos = t.live?.pos;
        if (!pos) continue;
        seen.add(t.id);
        const isSel = t.id === selectedId;
        const iconKey = `${t.mode}|${t.status}|${isSel}`;
        const cur = anims.get(t.id);
        if (cur) {
          const ll = cur.marker.getLatLng();
          cur.from = [ll.lat, ll.lng];
          cur.to = pos;
          cur.start = t0;
          cur.item = t;
          cur.heading = t.live?.heading ?? 0;
          if (cur.iconKey !== iconKey) {
            cur.marker.setIcon(trackIcon(t.mode, t.status, isSel));
            cur.iconKey = iconKey;
          }
          cur.marker.setZIndexOffset(isSel ? 1000 : 0);
          if (glyphRotates(t.mode)) setRotation(cur.marker, cur.heading);
        } else {
          const marker = L.marker(pos, { icon: trackIcon(t.mode, t.status, isSel), zIndexOffset: isSel ? 1000 : 0, keyboard: true, title: t.label || t.number })
            .on("click", () => {
              setTab("tracks");
              selectTrack(t.id);
            })
            .bindTooltip(`${t.label || t.number} · ${t.statusLabel}`, { direction: "top", offset: [0, -16] })
            .addTo(map);
          const anim: TrackAnim = { marker, from: pos, to: pos, start: t0, heading: t.live?.heading ?? 0, item: t, iconKey };
          anims.set(t.id, anim);
          if (glyphRotates(t.mode)) requestAnimationFrame(() => setRotation(marker, anim.heading));
        }
      }
    }
    for (const [id, a] of anims) {
      if (!seen.has(id)) {
        a.marker.remove();
        anims.delete(id);
      }
    }
  }, [map, items, selectedId, layers.tracks, selectTrack]);

  // ── Ambient AIS vessels ──────────────────────────────────────────────────
  useEffect(() => {
    if (!map) return;
    const anims = aisAnims.current;
    const seen = new Set<string>();
    if (layers.ais && zoom >= AIS_MIN_ZOOM) {
      for (const v of (snap?.vessels ?? []).slice(0, 700)) {
        seen.add(v.mmsi);
        const cur = anims.get(v.mmsi);
        if (cur) {
          cur.base = [v.lat, v.lng];
          cur.baseAt = Date.now();
          cur.v = v;
        } else {
          const marker = L.marker([v.lat, v.lng], { icon: aisIcon(v.type), interactive: true, keyboard: false })
            .bindTooltip(`${v.name || `MMSI ${v.mmsi}`}${v.sog != null ? ` · ${v.sog.toFixed(1)} вуз.` : ""}`, { direction: "top" })
            .addTo(map);
          anims.set(v.mmsi, { marker, base: [v.lat, v.lng], baseAt: Date.now(), v });
          requestAnimationFrame(() => setRotation(marker, v.cog ?? 0));
        }
      }
    }
    for (const [k, a] of anims) {
      if (!seen.has(k)) {
        a.marker.remove();
        anims.delete(k);
      }
    }
  }, [map, snap, layers.ais, zoom]);

  // ── Animation loop: glides every frame, estimates + dead reckoning ~1/s ──
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    let lastSlow = 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tick = (ts: number) => {
      for (const a of trackAnims.current.values()) {
        const f = Math.min(1, (ts - a.start) / GLIDE_MS);
        if (f < 1) {
          const e = 1 - (1 - f) ** 3;
          a.marker.setLatLng(lerp(a.from, a.to, e));
        }
      }
      if (!reduce && ts - lastSlow > 1000) {
        lastSlow = ts;
        const wall = Date.now();
        // In-transit estimates keep creeping along their lane between polls.
        for (const a of trackAnims.current.values()) {
          const it = a.item;
          if (it.live?.positionSource !== "estimate" || !it.departedAt || !it.eta) continue;
          if (ts - a.start < GLIDE_MS) continue;
          const t0 = new Date(it.departedAt).getTime();
          const t1 = new Date(it.eta).getTime();
          if (t1 <= t0) continue;
          const t = Math.max(0.02, Math.min(0.97, (wall - t0) / (t1 - t0)));
          const { point, heading } = splitAt(smoothPath(it.live.path), t);
          a.marker.setLatLng(point);
          a.to = point;
          if (glyphRotates(it.mode)) setRotation(a.marker, heading);
        }
        // AIS vessels drift by course/speed since their last fix.
        for (const a of aisAnims.current.values()) {
          const { sog, cog } = a.v;
          if (sog == null || cog == null || sog < 0.5) continue;
          const dt = Math.min(wall - a.baseAt, MAX_DR_MS);
          a.marker.setLatLng(advance(a.base, cog, (sog * 1.852 * dt) / 3_600_000));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [map]);

  // Clean up all imperative markers on unmount.
  useEffect(
    () => () => {
      for (const a of trackAnims.current.values()) a.marker.remove();
      for (const a of aisAnims.current.values()) a.marker.remove();
      trackAnims.current.clear();
      aisAnims.current.clear();
    },
    []
  );

  // Fly to a newly selected item.
  useEffect(() => {
    if (!map || !selected?.live?.pos) return;
    const z = Math.max(map.getZoom(), 4);
    // On phones the card covers the lower ~60% — keep the marker in the visible top part.
    const target = narrow
      ? map.unproject(map.project(L.latLng(selected.live.pos[0], selected.live.pos[1]), z).add([0, map.getSize().y * 0.3]), z)
      : L.latLng(selected.live.pos[0], selected.live.pos[1]);
    map.flyTo(target, z, { duration: 0.9 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selectedId]);

  // Fly to a selected port.
  useEffect(() => {
    if (!map || !selectedPort) return;
    const z = Math.max(map.getZoom(), 6);
    const ll = L.latLng(selectedPort.lat, selectedPort.lng);
    const target = narrow ? map.unproject(map.project(ll, z).add([0, map.getSize().y * 0.3]), z) : ll;
    map.flyTo(target, z, { duration: 0.9 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selPort]);

  // Fullscreen.
  useEffect(() => {
    const onFs = () => {
      setIsFull(document.fullscreenElement === wrapRef.current);
      window.setTimeout(() => map?.invalidateSize(), 120);
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [map]);

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  // ── HUD numbers ──────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const c = { moving: 0, port: 0, alert: 0, done: 0 };
    for (const t of items) {
      if (t.status === "in_transit" || t.status === "out_for_delivery") c.moving += 1;
      else if (t.status === "at_port" || t.status === "customs") c.port += 1;
      else if (t.status === "delivered") c.done += 1;
      if (t.status === "exception" || t.status === "unknown") c.alert += 1;
    }
    return c;
  }, [items]);
  const portIssues = useMemo(() => ports.filter((p) => p.status?.status === "closed" || p.status?.status === "disrupted").length, [ports]);

  const bm = BASEMAPS.find((b) => b.key === basemap) ?? BASEMAPS[0]!;
  const tileUrl = bm.key === "auto" ? (theme === "dark" ? TILE_DARK : TILE_LIGHT) : bm.url;
  const tileAttrib = bm.key === "auto" ? ATTRIB : `${bm.attribution} · AIS © aisstream.io`;
  const panelW = 340;
  const hasDetail = !!selected || !!selectedPort || !!selCarrier || !!selRoute;
  const showPanel = panelOpen && !(narrow && hasDetail);
  const leftInset = showPanel && !narrow ? panelW + 24 : 12;
  const rightInset = hasDetail && !narrow ? 384 : 12;
  const compactHud = hasDetail || narrow || wrapW - leftInset - rightInset < 900;

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", height: "100%", width: "100%", background: "var(--chat)", overflow: "hidden" }}
      data-testid="hub-map"
      data-picking={picking ? "1" : undefined}
    >
      <style>{`
        .aia-map .leaflet-container { background: var(--panel); font-family: var(--font-sans); }
        .aia-map .leaflet-tooltip { background: var(--surface); color: var(--text); border: 1px solid var(--border); box-shadow: var(--shadow); font-size: 12px; }
        .aia-map .leaflet-tooltip-top:before { border-top-color: var(--surface); }
        .aia-map .leaflet-control-scale-line { background: color-mix(in srgb, var(--surface) 80%, transparent); border-color: var(--border) !important; color: var(--muted); }
        .aia-map .leaflet-control-attribution { background: color-mix(in srgb, var(--surface) 80%, transparent) !important; color: var(--muted) !important; }
        .aia-map .leaflet-control-attribution a { color: var(--accent) !important; }
        ${HUB_MAP_CSS}
        ${HUB_PORT_CSS}
        [data-picking="1"] .aia-map, [data-picking="1"] .aia-map .leaflet-interactive { cursor: crosshair !important; }
      `}</style>

      {loading && (
        <div style={overlayCenter}>
          <IconSpinner size={26} />
        </div>
      )}

      <MapContainer
        ref={setMap}
        center={[30, 40]}
        zoom={3}
        minZoom={2}
        maxZoom={18}
        worldCopyJump
        zoomControl={false}
        className="aia-map"
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          key={`${bm.key}-${theme}`}
          url={tileUrl}
          attribution={tileAttrib}
          maxZoom={18}
          maxNativeZoom={bm.maxZoom}
        />
      </MapContainer>

      {/* Toolbar: zoom, layers, fullscreen */}
      <div
        style={{
          position: "absolute",
          top: 12,
          left: leftInset,
          right: rightInset,
          // Above the side panels while the layers menu is open.
          zIndex: layersOpen ? 1400 : 1200,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div style={{ ...glass, pointerEvents: "auto", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: 6, maxWidth: "100%" }}>
          {!showPanel && (
            <button
              type="button"
              style={iconBtn}
              onClick={() => {
                setPanelOpen(true);
                if (narrow) {
                  setSelectedId(null);
                  setSelPort(null);
                  setSelCarrier(null);
                  setSelRoute(null);
                }
              }}
              aria-label="Показати панель хабу"
              title="Панель хабу"
            >
              ☰
            </button>
          )}
          <button type="button" style={iconBtn} onClick={() => map?.zoomIn()} aria-label="Збільшити">
            +
          </button>
          <button type="button" style={iconBtn} onClick={() => map?.zoomOut()} aria-label="Зменшити">
            −
          </button>
          <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)" }} />
          <div style={{ position: "relative" }}>
            <button
              type="button"
              aria-haspopup="true"
              aria-expanded={layersOpen}
              onClick={() => setLayersOpen((v) => !v)}
              style={{ ...segBtn(true), border: "1px solid var(--border)" }}
            >
              <span aria-hidden>◫</span> Шари <span style={{ color: "var(--muted)", fontSize: 10 }}>▾</span>
            </button>
            {layersOpen && (
              <div
                role="menu"
                style={{
                  ...glass,
                  position: "absolute",
                  top: 38,
                  right: 0,
                  minWidth: 210,
                  maxHeight: "min(70vh, 560px)",
                  overflowY: "auto",
                  padding: 6,
                  display: "grid",
                  gap: 2,
                  background: "var(--surface)",
                }}
              >
                {LAYERS.map((l) => (
                  <button
                    key={l.key}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={layers[l.key]}
                    onClick={() => setLayers((st) => ({ ...st, [l.key]: !st[l.key] }))}
                    style={{ ...segBtn(layers[l.key]), justifyContent: "flex-start", width: "100%", border: 0 }}
                  >
                    <span style={{ width: 16, textAlign: "center", color: "var(--accent)" }}>{layers[l.key] ? "✓" : ""}</span>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: l.dot, opacity: layers[l.key] ? 1 : 0.35 }} />
                    {l.label}
                  </button>
                ))}
                {layers.ais && zoom < AIS_MIN_ZOOM && (
                  <div style={{ fontSize: 11, color: "var(--muted)", padding: "4px 8px" }}>Судна AIS видно при наближенні</div>
                )}
                <div style={{ height: 1, background: "var(--border)", margin: "4px 2px" }} />
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", padding: "4px 8px 2px" }}>
                  Стиль карти
                </div>
                {BASEMAPS.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={basemap === b.key}
                    onClick={() => chooseBasemap(b.key)}
                    style={{ ...segBtn(basemap === b.key), justifyContent: "flex-start", width: "100%", border: 0 }}
                  >
                    <span style={{ width: 16, textAlign: "center", color: "var(--accent)" }}>{basemap === b.key ? "●" : ""}</span>
                    <span style={{ width: 18, height: 14, borderRadius: 4, background: b.swatch, border: "1px solid var(--border)", flex: "none" }} />
                    {b.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" style={iconBtn} onClick={toggleFullscreen} aria-label="На весь екран" title="На весь екран">
            {isFull ? "🗗" : "⤢"}
          </button>
        </div>
      </div>

      {/* Left: tracks panel */}
      {showPanel && (
        <aside
          aria-label="Логістичний хаб"
          style={{
            ...glass,
            position: "absolute",
            zIndex: 1250,
            top: narrow ? "auto" : 12,
            left: 12,
            bottom: narrow ? 12 : 64,
            width: narrow ? "calc(100% - 24px)" : panelW,
            height: narrow ? "58%" : undefined,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "color-mix(in srgb, var(--surface) 94%, transparent)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 12px 0" }}>
            <span style={{ fontSize: 18 }} aria-hidden>
              🧭
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 750, fontSize: 15, lineHeight: 1.1 }}>Логістичний хаб</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Море · Авіа · Курʼєри · Україна</div>
            </div>
            <button type="button" onClick={() => setPanelOpen(false)} aria-label="Сховати панель" style={{ ...iconBtn, width: 30, height: 30, fontSize: 14 }}>
              ‹
            </button>
          </div>
          <div role="tablist" aria-label="Розділи хабу" style={{ display: "flex", gap: 4, padding: "10px 12px 0" }}>
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                style={{
                  flex: 1,
                  height: 32,
                  borderRadius: 9,
                  border: `1px solid ${tab === t.key ? "var(--border)" : "transparent"}`,
                  background: tab === t.key ? "var(--surface)" : "var(--hover)",
                  boxShadow: tab === t.key ? "0 1px 4px rgba(0,0,0,.06)" : "none",
                  color: tab === t.key ? "var(--text)" : "var(--muted)",
                  font: "inherit",
                  fontSize: 12.5,
                  fontWeight: 650,
                  cursor: "pointer",
                  padding: "0 4px",
                  whiteSpace: "nowrap",
                }}
              >
                {t.label}
                {t.key === "ports" && portIssues > 0 && <span style={{ marginLeft: 4, color: "var(--err)" }}>●{portIssues}</span>}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {tab === "tracks" ? (
              <TracksPanel
                items={items}
                selectedId={selectedId}
                onSelect={(id) => selectTrack(id)}
                onChanged={(id) => {
                  void reload(id);
                  loadPorts();
                }}
                workspaceId={workspaceId}
                workspaces={workspaces}
              />
            ) : tab === "ports" ? (
              <PortsPanel ports={ports} selectedCode={selPort} onSelect={(c) => selectPort(c)} onChanged={loadPorts} />
            ) : tab === "routes" ? (
              <RoutesPanel routes={routes} selectedId={selRoute === "new" ? null : selRoute} onSelect={(id) => selectRoute(id)} onNew={() => selectRoute("new")} />
            ) : (
              <LinesPanel
                carriers={carriers}
                lanes={lanes}
                selectedCarrier={selCarrier}
                selectedLane={selLane}
                onSelectCarrier={(id) => selectCarrier(id)}
                onSelectLane={setSelLane}
              />
            )}
          </div>
        </aside>
      )}

      {/* Right: detail card */}
      {selectedPort && (
        <aside
          aria-label="Деталі порту"
          style={{
            ...glass,
            position: "absolute",
            zIndex: 1260,
            top: narrow ? "auto" : 12,
            right: 12,
            bottom: narrow ? 12 : 64,
            width: narrow ? "calc(100% - 24px)" : 360,
            height: narrow ? "62%" : undefined,
            overflow: "hidden",
            background: "color-mix(in srgb, var(--surface) 96%, transparent)",
          }}
        >
          <PortDetail
            key={selectedPort.code}
            code={selectedPort.code}
            onClose={() => setSelPort(null)}
            onChanged={loadPorts}
            onOpenTrack={(id) => {
              setTab("tracks");
              selectTrack(id);
            }}
          />
        </aside>
      )}
      {selRoute && (
        <aside
          aria-label="Маршрут"
          style={{
            ...glass,
            position: "absolute",
            zIndex: 1260,
            top: narrow ? "auto" : 12,
            right: 12,
            bottom: narrow ? 12 : 64,
            width: narrow ? "calc(100% - 24px)" : 380,
            height: narrow ? "66%" : undefined,
            overflow: "hidden",
            background: "color-mix(in srgb, var(--surface) 97%, transparent)",
          }}
        >
          <RouteDetail
            key={selRoute}
            routeId={selRoute === "new" ? null : selRoute}
            ports={ports}
            tracks={items}
            carriers={carrierRefs}
            workspaces={workspaces}
            defaultWorkspaceId={workspaceId}
            onClose={() => selectRoute(null)}
            onSaved={(r) => {
              loadRoutes();
              setSelRoute(r.id);
            }}
            onDeleted={() => {
              selectRoute(null);
              loadRoutes();
            }}
            onPick={setPick}
            onDraftChange={setDraftLegs}
            onOpenTrack={(id) => {
              setTab("tracks");
              selectTrack(id);
            }}
          />
        </aside>
      )}
      {picking && (
        <div role="status" style={{ ...glass, position: "absolute", top: 64, left: "50%", transform: "translateX(-50%)", zIndex: 1300, padding: "8px 14px", fontSize: 13, display: "flex", gap: 10, alignItems: "center" }}>
          📍 Клікніть на карті, щоб обрати точку
          <button type="button" className="btn" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={() => setPick(null)}>
            Скасувати
          </button>
        </div>
      )}
      {selCarrier && (
        <aside
          aria-label="Деталі лінії"
          style={{
            ...glass,
            position: "absolute",
            zIndex: 1260,
            top: narrow ? "auto" : 12,
            right: 12,
            bottom: narrow ? 12 : 64,
            width: narrow ? "calc(100% - 24px)" : 360,
            height: narrow ? "62%" : undefined,
            overflow: "hidden",
            background: "color-mix(in srgb, var(--surface) 96%, transparent)",
          }}
        >
          <CarrierDetail
            key={selCarrier}
            id={selCarrier}
            tracks={items}
            onClose={() => selectCarrier(null)}
            onChanged={loadLines}
            onDetail={setCarrierDetail}
            onOpenTrack={(id) => {
              setTab("tracks");
              selectTrack(id);
            }}
          />
        </aside>
      )}
      {selected && (
        <aside
          aria-label="Деталі вантажу"
          style={{
            ...glass,
            position: "absolute",
            zIndex: 1260,
            top: narrow ? "auto" : 12,
            right: 12,
            bottom: narrow ? 12 : 64,
            width: narrow ? "calc(100% - 24px)" : 360,
            height: narrow ? "62%" : undefined,
            overflow: "hidden",
            background: "color-mix(in srgb, var(--surface) 96%, transparent)",
          }}
        >
          <TrackDetail
            key={selected.id}
            track={selected}
            workspaces={workspaces}
            onClose={() => selectTrack(null)}
            onChanged={() => void reload()}
            onRemoved={() => {
              setSelectedId(null);
              void reload();
            }}
          />
        </aside>
      )}

      {/* HUD: dispatcher strip */}
      {!(narrow && (showPanel || hasDetail)) && (
        <div
          style={{ position: "absolute", left: leftInset, right: rightInset, bottom: 18, zIndex: 1200, display: "flex", justifyContent: "center", pointerEvents: "none" }}
        >
          <div
            style={{ ...glass, pointerEvents: "auto", display: "flex", flexWrap: "nowrap", alignItems: "center", gap: compactHud ? 10 : 14, padding: "8px 14px", fontSize: 12.5, whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden" }}
            data-testid="hub-hud"
            data-tick={now}
          >
            <Stat icon="🚢" n={stats.moving} label="в дорозі" color="var(--accent)" compact={compactHud} />
            <Stat icon="⚓" n={stats.port} label="у порту / митниці" color="var(--warn)" compact={compactHud} />
            <Stat icon="⚠" n={stats.alert} label="потребують уваги" color="var(--err)" compact={compactHud} />
            <Stat icon="✓" n={stats.done} label="доставлено" color="var(--ok)" compact={compactHud} />
            <Stat icon="⛔" n={portIssues} label="портів і кордонів зі збоями" color="var(--err)" compact={compactHud} />
            <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)" }} />
            <span style={{ color: "var(--muted)" }} title="Живі позиції суден (aisstream.io)">
              <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: (snap?.vessels.length ?? 0) > 0 ? "var(--ok)" : "var(--faint)", marginRight: 6 }} />
              AIS: {(snap?.vessels.length ?? 0) > 0 ? `${snap!.vessels.length}${compactHud ? "" : " суден"}` : "—"}
            </span>
            <span style={{ color: "var(--faint)", display: compactHud ? "none" : undefined }}>
              оновлено {snap ? new Date(snapAt.current).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "—"}
            </span>
          </div>
        </div>
      )}

      {error && !loading && (
        <div role="alert" style={{ ...glass, position: "absolute", top: 70, left: "50%", transform: "translateX(-50%)", zIndex: 1300, padding: "8px 14px", fontSize: 13, color: "var(--err)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

function Stat({ icon, n, label, color, compact }: { icon: string; n: number; label: string; color: string; compact?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={label} aria-label={`${n} ${label}`}>
      <span aria-hidden>{icon}</span>
      <b style={{ color, fontSize: 14 }}>{n}</b>
      {!compact && <span style={{ color: "var(--muted)" }}>{label}</span>}
    </span>
  );
}

const glass: React.CSSProperties = {
  background: "color-mix(in srgb, var(--surface) 84%, transparent)",
  backdropFilter: "blur(12px) saturate(1.2)",
  WebkitBackdropFilter: "blur(12px) saturate(1.2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  boxShadow: "var(--shadow)",
};

const iconBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 32,
  width: 32,
  flex: "none",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 17,
  lineHeight: 1,
  fontWeight: 600,
  cursor: "pointer",
};

function segBtn(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 32,
    padding: "0 10px",
    borderRadius: 9,
    border: `1px solid ${active ? "var(--border)" : "transparent"}`,
    background: active ? "var(--surface)" : "transparent",
    color: active ? "var(--text)" : "var(--muted)",
    font: "inherit",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

const overlayCenter: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 1300,
  display: "grid",
  placeItems: "center",
  pointerEvents: "none",
};
