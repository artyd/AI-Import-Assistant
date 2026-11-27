"use client";

export function Stat({
  icon,
  n,
  label,
  color,
  compact,
  onClick,
  active,
  testId,
}: {
  icon: string;
  n: number;
  label: string;
  color: string;
  compact?: boolean;
  /** Makes the figure a shortcut: a click shows exactly these items. */
  onClick?: () => void;
  active?: boolean;
  testId?: string;
}) {
  const inner = (
    <>
      <span aria-hidden>{icon}</span>
      <b style={{ color, fontSize: 14 }}>{n}</b>
      {!compact && <span style={{ color: "var(--muted)" }}>{label}</span>}
    </>
  );
  if (!onClick) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={label} aria-label={`${n} ${label}`}>
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={!!active}
      aria-label={`${n} ${label}`}
      title={`Показати: ${label}`}
      data-testid={testId}
      className="hub-stat"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 26,
        padding: "0 8px",
        margin: "0 -4px",
        borderRadius: 8,
        border: `1px solid ${active ? `color-mix(in srgb, ${color} 55%, transparent)` : "transparent"}`,
        background: active ? `color-mix(in srgb, ${color} 12%, transparent)` : "transparent",
        color: "var(--text)",
        font: "inherit",
        fontSize: 12.5,
        cursor: "pointer",
      }}
    >
      {inner}
    </button>
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
