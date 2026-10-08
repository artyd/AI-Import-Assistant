"use client";

// "Порти" tab of the hub: every sea port, cargo airport and border crossing with
// its live operating status (AI from news or a logist's mark), personal ★
// favourites, quick filters and search. The quick filter is owned by HubCanvas
// so the map shows the same selection as the list.

import { useMemo, useState } from "react";
import {
  ago,
  PLACE_KIND_LABEL,
  portApi,
  portStatusColor,
  type HubPort,
  type PlaceKind,
} from "@/lib/hub";
import { pill } from "./TracksPanel";

export type PortFilter = "fav" | "issues" | "all" | PlaceKind;
type Filter = PortFilter;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "fav", label: "★ Обрані" },
  { key: "issues", label: "Проблеми" },
  { key: "all", label: "Всі" },
  { key: "sea", label: "Порти" },
  { key: "air", label: "Аеропорти" },
  { key: "customs", label: "Кордон" },
];

const KIND_ICON: Record<PlaceKind, string> = { sea: "⚓", air: "✈", customs: "🛂", inland: "📍" };

export function isIssue(p: HubPort): boolean {
  return p.status?.status === "closed" || p.status?.status === "disrupted" || p.status?.status === "congested";
}

/** Does a place pass the quick filter? (shared by the list and the map). */
export function portMatches(p: HubPort, f: PortFilter): boolean {
  if (p.kind === "inland") return false;
  if (f === "fav") return p.favorite;
  if (f === "issues") return isIssue(p);
  if (f === "all") return true;
  return p.kind === f;
}

/** The filter shown before the user picks one: favourites if any, else problems. */
export function defaultPortFilter(ports: HubPort[]): PortFilter {
  return ports.some((p) => p.favorite) ? "fav" : "issues";
}

export function PortsPanel({
  ports,
  selectedCode,
  filter,
  onFilter,
  onSelect,
  onChanged,
}: {
  ports: HubPort[];
  selectedCode: string | null;
  filter: PortFilter;
  onFilter: (f: PortFilter) => void;
  onSelect: (code: string) => void;
  onChanged: () => void;
}) {
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const counts = useMemo(
    () => ({
      fav: ports.filter((p) => p.favorite).length,
      issues: ports.filter(isIssue).length,
      all: ports.filter((p) => p.kind !== "inland").length,
      sea: ports.filter((p) => p.kind === "sea").length,
      air: ports.filter((p) => p.kind === "air").length,
      customs: ports.filter((p) => p.kind === "customs").length,
      inland: 0,
    }),
    [ports]
  );

  const visible = useMemo(() => {
    const t = q.trim().toLowerCase();
    let list = ports.filter((p) => p.kind !== "inland");
    if (t) {
      list = list.filter(
        (p) => p.name.toLowerCase().includes(t) || p.nameEn.toLowerCase().includes(t) || p.code.toLowerCase() === t
      );
    } else list = list.filter((p) => portMatches(p, filter));
    const rank = (p: HubPort) =>
      ({ closed: 0, disrupted: 1, congested: 2, ok: 3 })[p.status?.status ?? "ok"] + (p.status ? 0 : 4);
    return [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite) || rank(a) - rank(b) || a.name.localeCompare(b.name, "uk"));
  }, [ports, filter, q]);

  async function star(p: HubPort) {
    setPending(p.code);
    try {
      await portApi.favorite(p.code, !p.favorite);
      onChanged();
    } finally {
      setPending(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: 12, borderBottom: "1px solid var(--border)", display: "grid", gap: 8 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Пошук: Одеса, Constanta, IST, Ягодин…"
          aria-label="Пошук порту"
          data-testid="hub-port-search"
          style={{ height: 36, padding: "0 11px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", font: "inherit", fontSize: 13 }}
        />
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }} role="tablist" aria-label="Фільтр портів">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key && !q}
              onClick={() => {
                onFilter(f.key);
                setQ("");
              }}
              style={{
                height: 26,
                padding: "0 9px",
                borderRadius: 999,
                border: `1px solid ${filter === f.key && !q ? "var(--accent)" : "var(--border)"}`,
                background: filter === f.key && !q ? "var(--active)" : "transparent",
                color: "var(--text)",
                font: "inherit",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {f.label} <span style={{ opacity: 0.6 }}>{counts[f.key as keyof typeof counts]}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 8px 12px" }} data-testid="hub-port-list">
        {visible.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--muted)", padding: 12, lineHeight: 1.5 }}>
            {filter === "fav" && !q
              ? "Ще немає обраних. Натисніть ☆ біля порту, аеропорту чи пункту пропуску — і отримуватимете сповіщення, коли він зупиняється або відновлює роботу."
              : filter === "issues" && !q
                ? "Зараз немає позначок про проблеми."
                : "Нічого не знайдено."}
          </p>
        ) : (
          visible.slice(0, 150).map((p) => {
            const color = portStatusColor(p.status?.status);
            const sel = p.code === selectedCode;
            return (
              <div
                key={p.code}
                data-testid="hub-port-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 8px",
                  marginBottom: 4,
                  borderRadius: 10,
                  border: `1px solid ${sel ? color : "transparent"}`,
                  background: sel ? "var(--active)" : "transparent",
                }}
              >
                <button
                  type="button"
                  onClick={() => void star(p)}
                  disabled={pending === p.code}
                  aria-pressed={p.favorite}
                  aria-label={p.favorite ? `Прибрати ${p.name} з обраних` : `Додати ${p.name} в обрані`}
                  style={{ background: "none", border: 0, cursor: "pointer", fontSize: 17, lineHeight: 1, color: p.favorite ? "#f2b100" : "var(--faint)", padding: 2 }}
                >
                  {p.favorite ? "★" : "☆"}
                </button>
                <button
                  type="button"
                  onClick={() => onSelect(p.code)}
                  style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer", color: "var(--text)", font: "inherit" }}
                >
                  <span aria-hidden style={{ width: 18, textAlign: "center" }}>
                    {KIND_ICON[p.kind]}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontWeight: 620, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name}
                      {p.trackCount > 0 && <span style={{ color: "var(--accent)", fontWeight: 700 }}> · {p.trackCount} 📦</span>}
                    </span>
                    <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.code} · {p.country} · {PLACE_KIND_LABEL[p.kind]}
                      {p.status ? ` · ${p.status.by === "ai" ? "ШІ" : "команда"}, ${ago(p.status.updatedAt)}` : ""}
                    </span>
                  </span>
                  <span style={pill(color)}>{p.status ? p.status.label : "Немає даних"}</span>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
