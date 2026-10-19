"use client";
import { type CalRow, fmtDay, type SyncInfo } from "@/lib/calendar";
import { type Load } from "./load";

export function LoadBadge({ load, small }: { load: Load; small?: boolean }) {
  return (
    <span
      data-testid="calendar-load"
      title={load.title}
      style={{
        marginLeft: "auto",
        fontSize: small ? 10 : 11,
        fontWeight: 600,
        padding: "0 5px",
        borderRadius: 6,
        whiteSpace: "nowrap",
        background: load.heavy ? "color-mix(in srgb, #ea580c 18%, transparent)" : "var(--hover)",
        color: load.heavy ? "#c2410c" : "var(--muted)",
      }}
    >
      {load.text}
    </span>
  );
}

export function quickBtn(active: boolean): React.CSSProperties {
  return {
    height: 28,
    padding: "0 10px",
    borderRadius: 999,
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "var(--active)" : "var(--surface)",
    color: "var(--text)",
    font: "inherit",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

export function AttentionList({ rows, title, onPick, onClose }: { rows: CalRow[]; title?: string; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ flex: 1, fontSize: 15, fontWeight: 700 }}>{title ?? "⚠ Потребують уваги"}</div>
        <button type="button" onClick={onClose} aria-label="Закрити" style={closeBtn}>
          ×
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 8, display: "grid", gap: 6, alignContent: "start" }}>
        {rows.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--muted)", padding: 8 }}>Проблемних рядків немає.</p>
        ) : (
          rows.map((r) => (
            <button
              key={r.id}
              type="button"
              data-testid="calendar-attention-row"
              onClick={() => onPick(r.id)}
              style={{ textAlign: "left", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", padding: "8px 10px", font: "inherit", color: "var(--text)", cursor: "pointer" }}
            >
              <div style={{ fontSize: 13, fontWeight: 650 }}>
                {r.product} <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 11.5 }}>· рядок {r.rowIndex}</span>
              </div>
              {r.issues.map((i) => (
                <div key={i.code} style={{ fontSize: 12, color: "var(--err)" }}>
                  {i.label}
                </div>
              ))}
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                {[r.number, r.arrival ? `план ${fmtDay(r.arrival.date)}` : "", r.logist].filter(Boolean).join(" · ")}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function SyncBadge({ sync }: { sync: SyncInfo | null }) {
  if (!sync?.enabled) return null;
  const t = sync.tabs.find((x) => x.tab === "tracking");
  const failed = sync.tabs.filter((x) => !x.ok);
  const at = t?.syncedAt
    ? new Date(t.syncedAt).toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" })
    : "ще не синхронізовано";
  return (
    <span
      data-testid="calendar-sync"
      title={failed.length ? failed.map((f) => `${f.tab}: ${f.error}`).join("\n") : "Таблиця оновлюється щогодини"}
      style={{ fontSize: 12, color: failed.length ? "var(--err)" : "var(--muted)" }}
    >
      {failed.length ? "⚠ " : ""}Таблиця · {at}
    </span>
  );
}

export function FilterSelect({
  label,
  value,
  options,
  onChange,
  format = (v: string) => v,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  format?: (v: string) => string;
}) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--muted)" }}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        style={{
          height: 28,
          maxWidth: 160,
          borderRadius: 8,
          border: `1px solid ${value ? "var(--accent)" : "var(--border)"}`,
          background: "var(--surface)",
          color: "var(--text)",
          font: "inherit",
          fontSize: 12.5,
          padding: "0 6px",
        }}
      >
        <option value="">усі</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {format(o)}
          </option>
        ))}
      </select>
    </label>
  );
}
export const closeBtn: React.CSSProperties = {
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
