"use client";

// "Лінії" tab: which ocean carriers take cargo to Ukraine now, how they route
// Asia–Europe (Suez / around Africa), war-risk notes, and how punctual they were
// on the team's own deliveries — plus reference corridors into the Black Sea
// with a transit estimate computed from distance.

import { useMemo } from "react";
import {
  RED_SEA_LABEL,
  uaColor,
  UA_STATUS_LABEL,
  type CarrierSummary,
  type Lane,
} from "@/lib/hub";
import { pill } from "./TracksPanel";

export function reliabilityText(r: CarrierSummary["reliability"]): string {
  if (r.onTimeShare == null) return r.delivered ? `доставок: ${r.delivered} (замало для оцінки)` : "ще немає наших доставок";
  return `вчасно ${Math.round(r.onTimeShare * 100)}% · затримка ${r.avgDelayDays ?? 0} дн · ${r.delivered} дост.`;
}

export function LinesPanel({
  carriers,
  lanes,
  selectedCarrier,
  selectedLane,
  onSelectCarrier,
  onSelectLane,
}: {
  carriers: CarrierSummary[];
  lanes: Lane[];
  selectedCarrier: string | null;
  selectedLane: string | null;
  onSelectCarrier: (id: string) => void;
  onSelectLane: (id: string | null) => void;
}) {
  const sorted = useMemo(() => {
    const rank = (c: CarrierSummary) =>
      (c.reliability.inTransit > 0 ? 0 : 10) + ({ accepting: 0, limited: 1, suspended: 2 }[c.uaStatus?.value ?? "suspended"] ?? 3) + (c.uaStatus ? 0 : 4);
    return [...carriers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [carriers]);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "10px 8px 14px" }} data-testid="hub-lines">
      <div style={sectionTitle}>Морські лінії</div>
      {sorted.map((c) => {
        const sel = c.id === selectedCarrier;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelectCarrier(c.id)}
            data-testid="hub-carrier-row"
            style={{
              width: "100%",
              textAlign: "left",
              display: "grid",
              gap: 5,
              padding: "9px 10px",
              marginBottom: 5,
              borderRadius: 11,
              border: `1px solid ${sel ? "var(--accent)" : "var(--border)"}`,
              background: sel ? "var(--active)" : "var(--surface)",
              color: "var(--text)",
              font: "inherit",
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 680, fontSize: 13.5, flex: 1 }}>{c.name}</span>
              {c.reliability.inTransit > 0 && (
                <span style={{ fontSize: 11.5, color: "var(--accent)", fontWeight: 650 }}>🚢 {c.reliability.inTransit}</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              <span style={pill(uaColor(c.uaStatus?.value))}>{c.uaStatus ? UA_STATUS_LABEL[c.uaStatus.value] : "Україна: невідомо"}</span>
              <span style={pill(c.redSea?.value === "cape" ? "var(--warn)" : c.redSea ? "var(--accent)" : "var(--faint)")}>
                {c.redSea ? RED_SEA_LABEL[c.redSea.value] : "Маршрут: невідомо"}
              </span>
              {c.warRisk && <span style={pill("var(--err)")}>WRS</span>}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{reliabilityText(c.reliability)}</div>
          </button>
        );
      })}

      <div style={{ ...sectionTitle, marginTop: 14 }}>Коридори на Україну · орієнтовно</div>
      <p style={{ fontSize: 11.5, color: "var(--muted)", margin: "0 4px 8px", lineHeight: 1.45 }}>
        Час у дорозі розраховано за відстанню морськими коридорами (15 вузлів + заходи в порти), а не з розкладу лінії.
      </p>
      {lanes.map((l) => {
        const sel = l.id === selectedLane;
        return (
          <button
            key={l.id}
            type="button"
            data-testid="hub-lane-row"
            onClick={() => onSelectLane(sel ? null : l.id)}
            style={{
              width: "100%",
              textAlign: "left",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              marginBottom: 4,
              borderRadius: 10,
              border: `1px solid ${sel ? (l.via === "cape" ? "var(--warn)" : "var(--accent)") : "transparent"}`,
              background: sel ? "var(--hover)" : "transparent",
              color: "var(--text)",
              font: "inherit",
              cursor: "pointer",
            }}
          >
            <span style={{ width: 18, height: 3, borderRadius: 2, flex: "none", background: l.via === "cape" ? "var(--warn)" : "var(--accent)" }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{l.name}</span>
              <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)" }}>
                {l.rotation.map((r) => r.name).join(" → ")}
              </span>
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap" }}>
              {l.transitDaysMin}–{l.transitDaysMax} дн
            </span>
          </button>
        );
      })}
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--muted)",
  textTransform: "uppercase",
  letterSpacing: ".05em",
  margin: "2px 4px 8px",
};
