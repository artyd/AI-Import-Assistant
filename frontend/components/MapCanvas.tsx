"use client";

// Interactive map of ports / routes / shipments (Карта постачань). Native
// react-leaflet (no iframe). This module statically imports Leaflet, so it MUST
// only ever load client-side — MapView wraps it in dynamic(ssr:false). The
// chrome (toolbar / legend / popups) is inline-styled with the app's CSS tokens;
// the map layers are drawn imperatively so the reproduction matches the mock 1:1.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import type { MapRoute, Port, PortKind, Vessel } from "@/lib/types";
import { IconSpinner } from "@/components/icons";

const TILE_LIGHT =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}";
const TILE_DARK =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const ATTRIB = "Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors";

// Initial framing from the mock.
const FIT_BOUNDS: L.LatLngBoundsExpression = [
  [58, -14],
  [0, 124],
];

type LayerKey = "routes" | "vessels" | "ports" | "risks" | "customs";

interface Colors {
  accent: string;
  warn: string;
  err: string;
  ok: string;
}

const FALLBACK_COLORS: Colors = {
  accent: "#2f6feb",
  warn: "#d98213",
  err: "#dc4a4f",
  ok: "#12936a",
};

function readColors(): Colors {
  if (typeof document === "undefined") return FALLBACK_COLORS;
  const s = getComputedStyle(document.body);
  const g = (name: string, fb: string) => s.getPropertyValue(name).trim() || fb;
  return {
    accent: g("--accent", FALLBACK_COLORS.accent),
    warn: g("--warn", FALLBACK_COLORS.warn),
    err: g("--err", FALLBACK_COLORS.err),
    ok: g("--ok", FALLBACK_COLORS.ok),
  };
}

const PORT_KIND_LABEL: Record<PortKind, string> = {
  sea: "Морський порт",
  inland: "Внутрішній термінал",
  customs: "Митний пункт",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Активне",
  draft: "Чернетка",
  done: "Завершено",
  docs_in_progress: "Документи в роботі",
  docs_complete: "Документи готові",
  customs_ready: "Готово до митниці",
};

function esc(input: string): string {
  return input.replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c
  );
}

// ── Leaflet marker factories ─────────────────────────────────────────────────

function portDot(color: string): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<span style="display:block;width:12px;height:12px;border-radius:50%;background:${color};box-shadow:0 0 0 2px rgba(255,255,255,.85),0 1px 3px rgba(0,0,0,.35)"></span>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

function customsSquare(color: string): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<span style="display:flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:3px;background:${color};color:#fff;font-size:11px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.4)">✓</span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function vesselGlyph(kind: Vessel["kind"]): L.DivIcon {
  const glyph = kind === "truck" ? "🚚" : "🚢";
  return L.divIcon({
    className: "",
    html: `<span style="font-size:20px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">${glyph}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

// ── Chrome styles (glass panels, buttons) ────────────────────────────────────

const glass: React.CSSProperties = {
  background: "color-mix(in srgb, var(--surface) 82%, transparent)",
  backdropFilter: "blur(10px) saturate(1.2)",
  WebkitBackdropFilter: "blur(10px) saturate(1.2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  boxShadow: "var(--shadow)",
};

function iconBtn(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 34,
    width: 34,
    flex: "none",
    borderRadius: 9,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontSize: 18,
    lineHeight: 1,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function segBtn(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    height: 34,
    padding: "0 12px",
    borderRadius: 9,
    border: `1px solid ${active ? "var(--border)" : "transparent"}`,
    background: active ? "var(--surface)" : "transparent",
    color: active ? "var(--text)" : "var(--muted)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    opacity: active ? 1 : 0.6,
    whiteSpace: "nowrap",
    transition: "opacity .12s, background .12s",
  };
}

interface LayerDef {
  key: LayerKey;
  label: string;
  color: keyof Colors;
}

const LAYER_DEFS: LayerDef[] = [
  { key: "routes", label: "Маршрути", color: "accent" },
  { key: "vessels", label: "Судна / фури", color: "accent" },
  { key: "ports", label: "Порти", color: "ok" },
  { key: "risks", label: "Ризики", color: "err" },
  { key: "customs", label: "Митниця", color: "warn" },
];

export function MapCanvas() {
  const { theme } = useTheme();

  const [map, setMap] = useState<L.Map | null>(null);
  const [ports, setPorts] = useState<Port[]>([]);
  const [routes, setRoutes] = useState<MapRoute[]>([]);
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [colors, setColors] = useState<Colors>(FALLBACK_COLORS);
  const [toggles, setToggles] = useState<Record<LayerKey, boolean>>({
    routes: true,
    vessels: true,
    ports: true,
    risks: true,
    customs: true,
  });

  const [searchQ, setSearchQ] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [isFull, setIsFull] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<L.Layer[]>([]);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Concrete token colours for Leaflet — recompute whenever the theme flips.
  useEffect(() => {
    setColors(readColors());
  }, [theme]);

  // Fetch the three atlases once on mount.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [p, r, v] = await Promise.all([
          api<{ ports: Port[] }>("/api/map/ports"),
          api<{ routes: MapRoute[] }>("/api/map/routes"),
          api<{ vessels: Vessel[] }>("/api/map/shipments"),
        ]);
        if (cancelled) return;
        setPorts(p.ports ?? []);
        setRoutes(r.routes ?? []);
        setVessels(v.vessels ?? []);
      } catch {
        if (!cancelled) setError("Не вдалося завантажити дані карти.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Frame + metric scale once the Leaflet map exists.
  useEffect(() => {
    if (!map) return;
    map.fitBounds(FIT_BOUNDS);
    const scale = L.control.scale({ metric: true, imperial: false, position: "bottomright" });
    scale.addTo(map);
    return () => {
      scale.remove();
    };
  }, [map]);

  // Rebuild every layer whenever data, colours or toggles change. Cheap for the
  // demo's marker counts and keeps the toggle logic trivial.
  useEffect(() => {
    if (!map) return;
    for (const l of layersRef.current) l.remove();
    layersRef.current = [];
    const add = (l: L.Layer) => {
      l.addTo(map);
      layersRef.current.push(l);
    };

    if (toggles.routes) {
      for (const r of routes) {
        const pts = r.waypoints
          .filter((w) => Array.isArray(w) && w.length >= 2)
          .map((w) => [w[0], w[1]] as [number, number]);
        if (pts.length < 2) continue;
        const color = !toggles.risks
          ? colors.accent
          : r.risk === "high"
            ? colors.err
            : r.risk === "medium"
              ? colors.warn
              : colors.accent;
        add(
          L.polyline(pts, {
            color,
            weight: 3,
            opacity: 0.85,
            ...(r.mode === "land" ? { dashArray: "2 8" } : {}),
          })
        );
      }
    }

    if (toggles.ports) {
      for (const p of ports) {
        const color =
          p.kind === "sea" ? colors.accent : p.kind === "customs" ? colors.warn : colors.ok;
        add(
          L.marker([p.lat, p.lng], { icon: portDot(color) }).bindPopup(
            `<b>${esc(p.name)}</b><br/>${esc(PORT_KIND_LABEL[p.kind] ?? p.kind)}`
          )
        );
      }
    }

    if (toggles.customs) {
      for (const p of ports) {
        if (p.kind !== "customs") continue;
        add(
          L.marker([p.lat, p.lng], { icon: customsSquare(colors.warn) }).bindPopup(
            `<b>${esc(p.name)}</b><br/>Пункт митного контролю`
          )
        );
      }
    }

    if (toggles.vessels) {
      for (const v of vessels) {
        add(
          L.marker([v.lat, v.lng], { icon: vesselGlyph(v.kind) }).bindPopup(
            `<b>${esc(v.label)}</b><br/>${esc(STATUS_LABEL[v.status] ?? v.status)}`
          )
        );
      }
    }

    return () => {
      for (const l of layersRef.current) l.remove();
      layersRef.current = [];
    };
  }, [map, ports, routes, vessels, colors, toggles]);

  // Track native fullscreen and keep Leaflet's canvas sized to the container.
  useEffect(() => {
    const onFsChange = () => {
      setIsFull(document.fullscreenElement === wrapRef.current);
      window.setTimeout(() => map?.invalidateSize(), 120);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [map]);

  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    []
  );

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 3200);
  }, []);

  const toggle = useCallback((key: LayerKey) => {
    setToggles((t) => ({ ...t, [key]: !t[key] }));
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  const onSearch = useCallback(async () => {
    const q = searchQ.trim();
    if (!q || !map) return;
    const lc = q.toLowerCase();

    // Local first: ports (by name/code/country), then vessels (label/id).
    const port =
      ports.find((p) => p.code.toLowerCase() === lc) ??
      ports.find(
        (p) =>
          p.name.toLowerCase().includes(lc) || p.country.toLowerCase().includes(lc)
      );
    if (port) {
      map.flyTo([port.lat, port.lng], 6);
      showHint(`Знайдено порт: ${port.name}`);
      return;
    }
    const vessel = vessels.find(
      (v) => v.label.toLowerCase().includes(lc) || v.id.toLowerCase() === lc
    );
    if (vessel) {
      map.flyTo([vessel.lat, vessel.lng], 6);
      showHint(`Знайдено: ${vessel.label}`);
      return;
    }

    // Fallback: Nominatim geocode.
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`
      );
      const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
      const hit = arr[0];
      if (hit) {
        map.flyTo([parseFloat(hit.lat), parseFloat(hit.lon)], 7);
        showHint(`Знайдено: ${hit.display_name}`);
      } else {
        showHint("Нічого не знайдено");
      }
    } catch {
      showHint("Пошук наразі недоступний");
    }
  }, [searchQ, map, ports, vessels, showHint]);

  const tileUrl = theme === "dark" ? TILE_DARK : TILE_LIGHT;

  const layerButtons = useMemo(
    () =>
      LAYER_DEFS.map((d) => {
        const active = toggles[d.key];
        return (
          <button
            key={d.key}
            type="button"
            onClick={() => toggle(d.key)}
            style={segBtn(active)}
            aria-pressed={active}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: colors[d.color],
                opacity: active ? 1 : 0.4,
                flex: "none",
              }}
            />
            {d.label}
          </button>
        );
      }),
    [toggles, colors, toggle]
  );

  return (
    <div ref={wrapRef} style={{ position: "relative", height: "100%", width: "100%", background: "var(--chat)" }}>
      {/* Scoped Leaflet overrides: theme the popups + attribution with app tokens. */}
      <style>{`
        .aia-map .leaflet-container { background: var(--panel); font-family: var(--font-sans); }
        .aia-map .leaflet-popup-content-wrapper {
          background: var(--surface); color: var(--text);
          border: 1px solid var(--border); border-radius: var(--radius-sm);
          box-shadow: var(--shadow);
        }
        .aia-map .leaflet-popup-content { margin: 10px 12px; font-size: 13px; line-height: 1.45; }
        .aia-map .leaflet-popup-content b { color: var(--text); }
        .aia-map .leaflet-popup-tip { background: var(--surface); border: 1px solid var(--border); }
        .aia-map .leaflet-popup-close-button { color: var(--muted); }
        .aia-map .leaflet-bar, .aia-map .leaflet-control-scale-line {
          border-color: var(--border) !important; color: var(--muted);
        }
        .aia-map .leaflet-control-scale-line {
          background: color-mix(in srgb, var(--surface) 80%, transparent);
        }
        .aia-map .leaflet-control-attribution {
          background: color-mix(in srgb, var(--surface) 80%, transparent) !important;
          color: var(--muted) !important;
        }
        .aia-map .leaflet-control-attribution a { color: var(--accent) !important; }
      `}</style>

      {loading && (
        <div style={overlayCenter}>
          <IconSpinner size={26} />
        </div>
      )}
      {error && !loading && (
        <div style={overlayCenter}>
          <div style={{ ...glass, padding: "18px 22px", textAlign: "center", maxWidth: 360 }}>
            <p style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{error}</p>
          </div>
        </div>
      )}

      <MapContainer
        ref={setMap}
        center={[30, 40]}
        zoom={3}
        minZoom={2}
        maxZoom={19}
        worldCopyJump
        zoomControl={false}
        className="aia-map"
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer key={theme} url={tileUrl} attribution={ATTRIB} maxZoom={19} />
      </MapContainer>

      {/* Top toolbar */}
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          right: 12,
          zIndex: 1200,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            ...glass,
            pointerEvents: "auto",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            padding: 8,
            maxWidth: "100%",
          }}
        >
          <button type="button" style={iconBtn()} onClick={() => map?.zoomIn()} aria-label="Збільшити">
            +
          </button>
          <button type="button" style={iconBtn()} onClick={() => map?.zoomOut()} aria-label="Зменшити">
            −
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onSearch();
              }}
              placeholder="Пошук: порт, постачання або місце…"
              style={{
                height: 34,
                width: 240,
                maxWidth: "42vw",
                padding: "0 12px",
                borderRadius: 9,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                font: "inherit",
                fontSize: 13,
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              style={{ height: 34, padding: "0 14px" }}
              onClick={() => void onSearch()}
            >
              Знайти
            </button>
          </div>

          <div style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "2px 2px" }} />

          {layerButtons}

          <button type="button" style={iconBtn()} onClick={toggleFullscreen} aria-label="На весь екран" title="На весь екран">
            {isFull ? "🗗" : "⤢"}
          </button>
        </div>
      </div>

      {/* Transient search hint */}
      {hint && (
        <div
          style={{
            position: "absolute",
            top: 74,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1200,
            ...glass,
            padding: "8px 14px",
            fontSize: 13,
            color: "var(--text)",
            maxWidth: "90%",
            pointerEvents: "none",
          }}
        >
          {hint}
        </div>
      )}

      {/* Legend */}
      <div
        style={{
          position: "absolute",
          left: 12,
          bottom: 22,
          zIndex: 1200,
          ...glass,
          padding: "12px 14px",
          display: "grid",
          gap: 8,
          minWidth: 190,
        }}
      >
        <LegendLine kind="line" color={colors.accent} label="Маршрут / у графіку" />
        <LegendLine kind="line" color={colors.warn} label="Ризик затримки" />
        <LegendLine kind="line" color={colors.err} label="Критично / ADR" />
        <LegendLine kind="dot" color={colors.ok} label="Порт відправлення" />
        <LegendLine kind="dot" color={colors.warn} label="Митний контроль" />
      </div>
    </div>
  );
}

const overlayCenter: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 1300,
  display: "grid",
  placeItems: "center",
  pointerEvents: "none",
};

function LegendLine({
  kind,
  color,
  label,
}: {
  kind: "line" | "dot";
  color: string;
  label: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--text)" }}>
      {kind === "line" ? (
        <span style={{ width: 22, height: 3, borderRadius: 2, background: color, flex: "none" }} />
      ) : (
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: color,
            flex: "none",
            boxShadow: "0 0 0 2px color-mix(in srgb, var(--surface) 90%, transparent)",
          }}
        />
      )}
      {label}
    </div>
  );
}
