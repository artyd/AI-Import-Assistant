"use client";

// "Маршрути" tab: planned multimodal routes with their health (on track /
// delayed / at risk), projected arrival vs plan, cost and demurrage exposure.

import {
  fmtDate,
  healthColor,
  HEALTH_LABEL,
  money,
  ROUTE_MODE_ICON,
  type PlannedRoute,
} from "@/lib/hub";
import { pill } from "./TracksPanel";

export function RoutesPanel({
  routes,
  selectedId,
  onSelect,
  onNew,
}: {
  routes: PlannedRoute[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
        <button type="button" className="btn btn-primary" style={{ width: "100%", height: 36 }} onClick={onNew} data-testid="hub-route-new">
          + Новий маршрут
        </button>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6, lineHeight: 1.45 }}>
          Плечі море / авіа / авто / залізниця / митниця, підказки Штурмана, вартість і free time — та план проти факту за трек-номерами.
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 8px 12px" }} data-testid="hub-route-list">
        {routes.length === 0 ? (
          <div style={{ padding: "18px 10px", textAlign: "center", color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
            <div style={{ fontSize: 30 }} aria-hidden>
              🗺️
            </div>
            Ще немає маршрутів. Створіть перший — або попросіть Штурмана запропонувати варіанти.
          </div>
        ) : (
          routes.map((r) => {
            const s = r.summary;
            const color = healthColor(s.health);
            const sel = r.id === selectedId;
            const dem = Object.keys(s.demurrage).length > 0;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => onSelect(r.id)}
                data-testid="hub-route-row"
                style={{
                  width: "100%",
                  textAlign: "left",
                  display: "grid",
                  gap: 5,
                  padding: "10px",
                  marginBottom: 6,
                  borderRadius: 11,
                  border: `1px solid ${sel ? color : "var(--border)"}`,
                  background: sel ? "var(--active)" : "var(--surface)",
                  color: "var(--text)",
                  font: "inherit",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 680, fontSize: 13.5, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  <span style={pill(color)}>{HEALTH_LABEL[s.health]}</span>
                </div>
                <div style={{ fontSize: 15, letterSpacing: 2 }} aria-label="Плечі">
                  {r.legs.map((l) => ROUTE_MODE_ICON[l.mode]).join(" › ")}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.legs[0]?.from.name || "—"} → {r.legs[r.legs.length - 1]?.mode === "customs" ? r.legs[r.legs.length - 1]?.from.name : r.legs[r.legs.length - 1]?.to.name || "—"}
                  {r.workspaceNumber ? ` · №${r.workspaceNumber}` : ""}
                </div>
                <div style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span>
                    План: <b>{fmtDate(s.plannedEnd)}</b>
                  </span>
                  {s.projectedEnd && s.delayDays !== 0 && (
                    <span style={{ color: s.delayDays > 0 ? "var(--err)" : "var(--ok)" }}>
                      Прогноз: {fmtDate(s.projectedEnd)} ({s.delayDays > 0 ? "+" : ""}
                      {s.delayDays} дн)
                    </span>
                  )}
                  <span style={{ color: "var(--muted)" }}>{money(s.costs)}</span>
                  {dem && <span style={{ color: "var(--err)", fontWeight: 650 }}>Демередж {money(s.demurrage)}</span>}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
