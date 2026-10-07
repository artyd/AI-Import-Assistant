"use client";

// Hub search: one box for tracked numbers / labels, shipments (№), saved
// routes, ports · airports · crossings (UA/EN name or code) and — as a fallback —
// any place on Earth via OpenStreetMap Nominatim. Arrow keys + Enter.

import { useMemo, useRef, useState } from "react";
import type { HubPort, PlannedRoute, Track } from "@/lib/hub";
import type { WorkspaceRef } from "./TracksPanel";

type Result =
  | { kind: "track"; id: string; title: string; sub: string }
  | { kind: "route"; id: string; title: string; sub: string }
  | { kind: "port"; id: string; title: string; sub: string }
  | { kind: "shipment"; id: string; title: string; sub: string }
  | { kind: "place"; id: string; title: string; sub: string };

const ICON: Record<Result["kind"], string> = { track: "📦", route: "🗺️", port: "⚓", shipment: "📁", place: "🌍" };

export function MapSearch({
  ports,
  items,
  routes,
  workspaces,
  onTrack,
  onPort,
  onRoute,
  onShipment,
  onPlace,
}: {
  ports: HubPort[];
  items: Track[];
  routes: PlannedRoute[];
  workspaces: WorkspaceRef[];
  onTrack: (id: string) => void;
  onPort: (code: string) => void;
  onRoute: (id: string) => void;
  onShipment: (workspaceId: string) => void;
  onPlace: (p: { lat: number; lng: number; name: string }) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const results = useMemo<Result[]>(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    const has = (s: string | null | undefined) => !!s && s.toLowerCase().includes(t);
    const out: Result[] = [];
    for (const it of items) {
      if (has(it.number) || has(it.label) || has(it.workspaceNumber))
        out.push({ kind: "track", id: it.id, title: it.label || it.number, sub: `${it.number} · ${it.carrierName} · ${it.statusLabel}` });
    }
    for (const w of workspaces) {
      if (has(w.number) || has(w.supplier)) out.push({ kind: "shipment", id: w.id, title: `Постачання №${w.number}`, sub: w.supplier || "вантажі та маршрути поставки" });
    }
    for (const r of routes) {
      if (has(r.name) || has(r.workspaceNumber)) out.push({ kind: "route", id: r.id, title: r.name, sub: `маршрут · ${r.legs.length} плеч(а)` });
    }
    const portHits = ports
      .filter((p) => p.code.toLowerCase() === t || has(p.name) || has(p.nameEn))
      .sort((a, b) => Number(b.code.toLowerCase() === t) - Number(a.code.toLowerCase() === t) || a.name.length - b.name.length)
      .slice(0, 6);
    for (const p of portHits) out.push({ kind: "port", id: p.code, title: p.name, sub: `${p.code} · ${p.country}${p.status ? ` · ${p.status.label}` : ""}` });
    out.push({ kind: "place", id: q.trim(), title: `Знайти на карті: «${q.trim()}»`, sub: "місто, адреса, обʼєкт (OpenStreetMap)" });
    return out.slice(0, 12);
  }, [q, items, workspaces, routes, ports]);

  async function choose(r: Result) {
    setOpen(false);
    setMsg(null);
    if (r.kind === "track") return onTrack(r.id);
    if (r.kind === "port") return onPort(r.id);
    if (r.kind === "route") return onRoute(r.id);
    if (r.kind === "shipment") return onShipment(r.id);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=uk&q=${encodeURIComponent(r.id)}`);
      const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
      const hit = arr[0];
      if (hit) onPlace({ lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), name: hit.display_name });
      else setMsg("Нічого не знайдено");
    } catch {
      setMsg("Пошук місць зараз недоступний");
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <input
        value={q}
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="hub-search-results"
        aria-label="Пошук на карті"
        data-testid="hub-search"
        placeholder="🔍 Пошук: трек, постачання, порт, місто…"
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
          setMsg(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && results[active]) {
            e.preventDefault();
            void choose(results[active]!);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        style={{
          width: "100%",
          height: 34,
          padding: "0 11px",
          borderRadius: 9,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          font: "inherit",
          fontSize: 13,
        }}
      />
      {open && results.length > 0 && (
        <ul
          id="hub-search-results"
          role="listbox"
          data-testid="hub-search-results"
          style={{
            position: "absolute",
            top: 38,
            left: 0,
            right: 0,
            zIndex: 20,
            margin: 0,
            padding: 4,
            listStyle: "none",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "var(--shadow)",
            maxHeight: 340,
            overflowY: "auto",
          }}
        >
          {results.map((r, i) => (
            <li
              key={`${r.kind}:${r.id}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                if (blurTimer.current) clearTimeout(blurTimer.current);
                void choose(r);
              }}
              onMouseEnter={() => setActive(i)}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "6px 8px",
                borderRadius: 7,
                cursor: "pointer",
                background: i === active ? "var(--active)" : "transparent",
              }}
            >
              <span aria-hidden style={{ width: 18, textAlign: "center" }}>
                {ICON[r.kind]}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sub}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {msg && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{msg}</div>}
    </div>
  );
}
