"use client";

// «Список» view of the logist calendar: the month's events as a table grouped by
// day — date, event, cargo type, product, tracking number (link), who carries it,
// route, logist, status, notes. Sortable; rows open the same card as the grid.

import { useMemo, useState } from "react";
import {
  CARGO_META,
  EVENT_META,
  fmtDay,
  forwarderColor,
  isWeekend,
  uaHoliday,
  WEEKDAYS_UK,
  type CalEvent,
  type CalRow,
} from "@/lib/calendar";

type SortKey = "date" | "product" | "forwarder" | "destination";

export function ListView({
  events,
  rowsById,
  today,
  selected,
  onPick,
}: {
  events: CalEvent[];
  rowsById: Map<string, CalRow>;
  today: string;
  selected: string | null;
  onPick: (rowId: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>("date");
  const items = useMemo(() => {
    const list = events.map((e) => ({ e, r: rowsById.get(e.rowId)! })).filter((x) => x.r);
    const key = (x: { e: CalEvent; r: CalRow }) =>
      sort === "date" ? x.e.date : sort === "product" ? x.r.product : sort === "forwarder" ? x.r.forwarder : x.r.destination;
    return list.sort((a, b) => key(a).localeCompare(key(b), "uk") || a.e.date.localeCompare(b.e.date));
  }, [events, rowsById, sort]);

  if (!items.length) return null;
  const head = (k: SortKey, label: string) => (
    <th
      style={{ ...th, cursor: "pointer", color: sort === k ? "var(--accent)" : "var(--muted)" }}
      onClick={() => setSort(k)}
      aria-sort={sort === k ? "ascending" : "none"}
    >
      {label}
      {sort === k ? " ↓" : ""}
    </th>
  );
  let lastDay = "";
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }} data-testid="calendar-list">
      <thead>
        <tr>
          {head("date", "Дата")}
          <th style={th}>Подія</th>
          <th style={th}>Тип</th>
          {head("product", "Товар")}
          <th style={th}>Трек-номер</th>
          {head("forwarder", "Хто везе")}
          {head("destination", "Маршрут")}
          <th style={th}>Логіст</th>
          <th style={th}>Статус</th>
        </tr>
      </thead>
      <tbody>
        {items.map(({ e, r }) => {
          const dayRow = sort === "date" && e.date !== lastDay;
          lastDay = e.date;
          const wd = WEEKDAYS_UK[(new Date(`${e.date}T00:00:00Z`).getUTCDay() + 6) % 7];
          const hol = uaHoliday(e.date);
          const m = EVENT_META[e.type];
          return [
            dayRow ? (
              <tr key={`d-${e.date}`}>
                <td
                  colSpan={9}
                  style={{
                    padding: "10px 8px 4px",
                    fontWeight: 700,
                    color: e.date === today ? "var(--accent)" : isWeekend(e.date) ? "var(--muted)" : "var(--text)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  {wd}, {fmtDay(e.date)}
                  {e.date === today ? " · сьогодні" : ""}
                  {hol ? <span style={{ marginLeft: 8, color: "var(--err)", fontWeight: 500, fontSize: 12 }}>🇺🇦 {hol}</span> : null}
                </td>
              </tr>
            ) : null,
            <tr
              key={e.id}
              data-testid="calendar-list-row"
              onClick={() => onPick(r.id)}
              style={{ cursor: "pointer", background: selected === r.id ? "var(--active)" : undefined, borderBottom: "1px solid var(--border)" }}
            >
              <td style={td}>{sort === "date" ? "" : fmtDay(e.date)}</td>
              <td style={td}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 7px", borderRadius: 999, background: `color-mix(in srgb, ${m.color} 16%, transparent)`, color: m.color, fontWeight: 600, whiteSpace: "nowrap" }}>
                  {m.icon} {m.label}
                  {e.approx ? " ≈" : ""}
                </span>
                {e.source ? <div style={{ fontSize: 11, color: "var(--muted)" }}>{e.source}</div> : null}
              </td>
              <td style={td} title={CARGO_META[r.cargoType].label}>
                {CARGO_META[r.cargoType].icon}
              </td>
              <td style={{ ...td, fontWeight: 600 }}>
                {r.product}
                {r.notesCount > 0 ? <span style={{ marginLeft: 6, fontWeight: 400, color: "var(--muted)" }}>💬 {r.notesCount}</span> : null}
              </td>
              <td style={{ ...td, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
                {r.number ? (
                  r.trackLink ? (
                    <a href={r.trackLink} target="_blank" rel="noreferrer noopener" onClick={(ev) => ev.stopPropagation()} style={{ color: "var(--accent)", textDecoration: "none" }}>
                      {r.number} ↗
                    </a>
                  ) : (
                    r.number
                  )
                ) : (
                  "—"
                )}
              </td>
              <td style={td}>
                {r.forwarder ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: forwarderColor(r.forwarder) }} />
                    {r.forwarder}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td style={td}>{[r.origin, r.destination].filter(Boolean).join(" → ") || "—"}</td>
              <td style={td}>{r.logist || "—"}</td>
              <td style={td}>{r.statusLabel}</td>
            </tr>,
          ];
        })}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  fontSize: 11.5,
  fontWeight: 650,
  textTransform: "uppercase",
  letterSpacing: ".04em",
  borderBottom: "2px solid var(--border)",
  position: "sticky",
  top: 0,
  background: "var(--bg, var(--surface))",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = { padding: "6px 8px", verticalAlign: "top" };
