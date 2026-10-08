"use client";

// «Пунктуальність»: per forwarder, this year — how many shipments arrived vs the
// sheet's plan, share on time (≤ 1 day late), average / worst delay, and how many
// open ones are already past their plan.

import { useEffect, useState } from "react";
import { calendarApi, forwarderColor, type Punctuality } from "@/lib/calendar";

export function PunctualityPanel({ onClose, onForwarder }: { onClose: () => void; onForwarder: (f: string) => void }) {
  const [rows, setRows] = useState<Punctuality[] | null>(null);
  useEffect(() => {
    calendarApi
      .punctuality()
      .then((r) => setRows(r.rows))
      .catch(() => setRows([]));
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }} data-testid="calendar-punctuality">
      <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>📊 Пунктуальність</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Факт прибуття проти плану з таблиці, цей рік</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Закрити" style={closeBtn}>
          ×
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 10, display: "grid", gap: 8, alignContent: "start" }}>
        {rows === null ? (
          <p style={{ fontSize: 13, color: "var(--muted)" }}>Завантаження…</p>
        ) : rows.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--muted)" }}>Ще немає вантажів з планом і фактом прибуття.</p>
        ) : (
          rows.map((p) => {
            const pct = p.count ? Math.round((p.onTime / p.count) * 100) : 0;
            const good = pct >= 80;
            return (
              <button
                key={p.forwarder}
                type="button"
                onClick={() => onForwarder(p.forwarder)}
                title="Показати в календарі лише цього експедитора"
                data-testid="calendar-punctuality-row"
                style={{ textAlign: "left", border: "1px solid var(--border)", borderLeft: `5px solid ${forwarderColor(p.forwarder)}`, borderRadius: 10, background: "var(--surface)", padding: "8px 10px", font: "inherit", color: "var(--text)", cursor: "pointer" }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <b style={{ flex: 1, fontSize: 13.5 }}>{p.forwarder}</b>
                  {p.count > 0 && <b style={{ fontSize: 15, color: good ? "var(--ok)" : pct >= 50 ? "var(--warn)" : "var(--err)" }}>{pct}%</b>}
                </div>
                {p.count > 0 && (
                  <div style={{ height: 5, borderRadius: 5, background: "var(--hover)", overflow: "hidden", margin: "5px 0" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: good ? "var(--ok)" : pct >= 50 ? "var(--warn)" : "var(--err)" }} />
                  </div>
                )}
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  {p.count > 0
                    ? `вчасно ${p.onTime} з ${p.count} · середнє ${p.avgDelay > 0 ? "+" : ""}${p.avgDelay} дн · найбільше +${Math.max(0, p.maxDelay)} дн`
                    : "ще без фактичних прибуттів"}
                  {p.overdueOpen > 0 ? <span style={{ color: "var(--err)" }}> · план минув: {p.overdueOpen}</span> : null}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

const closeBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  flex: "none",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--muted)",
  fontSize: 18,
  lineHeight: 1,
  cursor: "pointer",
};
