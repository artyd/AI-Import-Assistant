"use client";

export function Stat({ icon, n, label, color, compact }: { icon: string; n: number; label: string; color: string; compact?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={label} aria-label={`${n} ${label}`}>
      <span aria-hidden>{icon}</span>
      <b style={{ color, fontSize: 14 }}>{n}</b>
      {!compact && <span style={{ color: "var(--muted)" }}>{label}</span>}
    </span>
  );
}

export function segBtn(active: boolean): React.CSSProperties {
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
