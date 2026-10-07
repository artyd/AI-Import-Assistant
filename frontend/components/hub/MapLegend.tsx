"use client";

// Collapsible map legend (bottom-right): what every colour, line style and
// badge on the hub map means. Open/closed state is remembered per browser.

import { useEffect, useState } from "react";
import { PORT_STATUS_LABEL, portStatusColor, ROUTE_MODE_COLOR, ROUTE_MODE_LABEL, RISK_ZONES, type PortStatus, type RouteMode } from "@/lib/hub";
import { PLACE_KIND_COLOR } from "./mapIcons";

const STORE = "hub-legend-open";

export function MapLegend({ right, bottom }: { right: number; bottom: number }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setOpen(localStorage.getItem(STORE) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  function toggle() {
    setOpen((v) => {
      try {
        localStorage.setItem(STORE, v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  }

  return (
    <div style={{ position: "absolute", right, bottom, zIndex: 1210, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
      {open && (
        <div
          role="region"
          aria-label="Легенда карти"
          data-testid="hub-legend"
          style={{
            width: 270,
            maxHeight: "min(62vh, 560px)",
            overflowY: "auto",
            padding: "10px 12px",
            background: "color-mix(in srgb, var(--surface) 95%, transparent)",
            backdropFilter: "blur(12px)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow)",
            display: "grid",
            gap: 10,
            fontSize: 12,
          }}
        >
          <Group title="Порти та пункти">
            <Row icon={<Tile color={PLACE_KIND_COLOR.sea!} glyph="⚓" />} label="Морський порт" />
            <Row icon={<Tile color={PLACE_KIND_COLOR.air!} glyph="✈" />} label="Аеропорт" />
            <Row icon={<Tile color={PLACE_KIND_COLOR.customs!} glyph="✓" />} label="Пункт пропуску / кордон" />
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", marginTop: 2 }}>
              {(["ok", "congested", "disrupted", "closed"] as PortStatus[]).map((s) => (
                <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <Dot color={portStatusColor(s)} /> {PORT_STATUS_LABEL[s]}
                </span>
              ))}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--muted)" }}>без крапки — немає даних</span>
            </div>
            <Row icon={<span style={{ color: "#f2b100", fontSize: 14 }}>★</span>} label="Обраний (сповіщення про зупинку)" />
            <Row
              icon={
                <span style={{ display: "grid", placeItems: "center", width: 20, height: 20, borderRadius: "50%", fontSize: 10, fontWeight: 700, boxShadow: "0 0 0 2px var(--err)", background: "var(--surface)" }}>
                  5
                </span>
              }
              label="Група обʼєктів — колір за найгіршим статусом"
            />
          </Group>

          <Group title="Вантажі">
            <Row icon={<Dot color="var(--accent)" />} label="В дорозі / доставка" />
            <Row icon={<Dot color="var(--warn)" />} label="У порту / на митниці" />
            <Row icon={<Dot color="var(--ok)" />} label="Доставлено" />
            <Row icon={<Dot color="var(--err)" />} label="Проблема" />
            <Row icon={<Dot color="var(--muted)" />} label="Немає даних від перевізника" />
            <Row icon={<Badge text="5 дн" />} label="Днів до ETA" />
            <Row icon={<Badge text="5 дн" late />} label="ETA зсунулась — запізнюється" />
            <Row icon={<Line color="var(--accent)" />} label="Пройдено" />
            <Row icon={<Line color="var(--accent)" dashed />} label="Залишилось (орієнтовно)" />
          </Group>

          <Group title="Маршрути (план / факт)">
            {(Object.keys(ROUTE_MODE_COLOR) as RouteMode[]).map((m) => (
              <Row key={m} icon={<Line color={ROUTE_MODE_COLOR[m]} dashed />} label={`План · ${ROUTE_MODE_LABEL[m]}`} />
            ))}
            <Row icon={<Line color="#dc4a4f" thick />} label="Факт із запізненням (за трекінгом)" />
          </Group>

          <Group title="Лінії та ризики">
            <Row icon={<Line color="#2f6feb" />} label="Коридор через Суец" />
            <Row icon={<Line color="#d98213" dashed />} label="Коридор в обхід Африки" />
            <Row icon={<Line color="#7c3aed" thick />} label="Сервіс обраної лінії" />
            {RISK_ZONES.map((z) => (
              <Row key={z.id} icon={<Fill color={z.color} />} label={z.name} />
            ))}
          </Group>

          <Group title="Судна AIS">
            <Row icon={<Arrow color="#0f9b8e" />} label="Вантажне" />
            <Row icon={<Arrow color="#d98213" />} label="Танкер" />
            <Row icon={<Arrow color="#7d8a99" />} label="Інше" />
          </Group>
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? "Сховати легенду" : "Легенда"}
        title="Легенда карти"
        style={{
          height: 32,
          padding: "0 12px",
          borderRadius: 999,
          border: "1px solid var(--border)",
          background: "color-mix(in srgb, var(--surface) 92%, transparent)",
          boxShadow: "var(--shadow)",
          color: "var(--text)",
          font: "inherit",
          fontSize: 12.5,
          fontWeight: 650,
          cursor: "pointer",
        }}
      >
        {open ? "✕ Легенда" : "ⓘ Легенда"}
      </button>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 5 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>{title}</div>
      {children}
    </section>
  );
}

function Row({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 38, display: "grid", placeItems: "center", flex: "none" }}>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

const Dot = ({ color }: { color: string }) => (
  <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, boxShadow: "0 0 0 2px var(--surface)", display: "inline-block" }} />
);
const Tile = ({ color, glyph }: { color: string; glyph: string }) => (
  <span style={{ display: "grid", placeItems: "center", width: 18, height: 18, borderRadius: 5, background: color, color: "#fff", fontSize: 10.5, fontWeight: 700 }}>{glyph}</span>
);
const Badge = ({ text, late }: { text: string; late?: boolean }) => (
  <span
    style={{
      padding: "0 5px",
      borderRadius: 999,
      fontSize: 10,
      fontWeight: 700,
      lineHeight: "16px",
      whiteSpace: "nowrap",
      color: late ? "#fff" : "var(--text)",
      background: late ? "var(--err)" : "var(--surface)",
      boxShadow: late ? "none" : "0 0 0 1px var(--border)",
    }}
  >
    {text}
  </span>
);
const Line = ({ color, dashed, thick }: { color: string; dashed?: boolean; thick?: boolean }) => (
  <svg width="28" height="8" aria-hidden>
    <line x1="1" y1="4" x2="27" y2="4" stroke={color} strokeWidth={thick ? 4 : 3} strokeDasharray={dashed ? "5 4" : undefined} strokeLinecap="round" />
  </svg>
);
const Fill = ({ color }: { color: string }) => (
  <span style={{ width: 22, height: 12, borderRadius: 3, background: `color-mix(in srgb, ${color} 40%, transparent)`, border: `2px solid ${color}` }} />
);
const Arrow = ({ color }: { color: string }) => (
  <svg viewBox="0 0 10 14" width="9" height="13" aria-hidden>
    <path d="M5 0 10 14 5 11 0 14Z" fill={color} />
  </svg>
);
