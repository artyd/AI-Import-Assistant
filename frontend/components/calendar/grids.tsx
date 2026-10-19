"use client";
import { type CalEvent, type CalRow, addDays, uaHoliday, isWeekend, WEEKDAYS_UK, isoWeek, MONTHS_UK, daysInMonth, EVENT_META, CARGO_META, forwarderColor, EVENT_SHAPE } from "@/lib/calendar";
import { dayLoad, yearTitle } from "./load";
import { LoadBadge } from "./controls";

// ── Views ────────────────────────────────────────────────────────────────────

interface GridProps {
  today: string;
  byDay: Map<string, CalEvent[]>;
  rowsById: Map<string, CalRow>;
  onPick: (rowId: string) => void;
  selected: string | null;
}

export function WeekGrid({ from, ...p }: GridProps & { from: string }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6, minWidth: 840 }} data-testid="calendar-week">
      {days.map((d, i) => {
        const list = p.byDay.get(d) ?? [];
        const isToday = d === p.today;
        const hol = uaHoliday(d);
        const load = dayLoad(list, p.rowsById);
        return (
          <div
            key={d}
            data-day={d}
            style={{
              border: `1px solid ${isToday ? "var(--accent)" : load.heavy ? "#ea580c" : "var(--border)"}`,
              borderRadius: 12,
              background: isWeekend(d) || hol ? "color-mix(in srgb, var(--hover) 70%, var(--surface))" : "var(--surface)",
              minHeight: 360,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: isWeekend(d) || hol ? "var(--err)" : "var(--muted)", fontWeight: 600 }}>{WEEKDAYS_UK[i]}</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: isToday ? "var(--accent)" : "var(--text)" }}>{Number(d.slice(8, 10))}</span>
              {load.text && <LoadBadge load={load} />}
              {hol && <span style={{ width: "100%", fontSize: 10.5, color: "var(--err)" }}>🇺🇦 {hol}</span>}
            </div>
            <div style={{ padding: 6, display: "grid", gap: 5, alignContent: "start" }}>
              {list.map((e) => (
                <EventChip key={e.id} e={e} row={p.rowsById.get(e.rowId)!} onPick={p.onPick} selected={p.selected === e.rowId} wide />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function MonthGrid({ from, anchor, onDay, ...p }: GridProps & { from: string; anchor: string; onDay: (d: string) => void }) {
  const month = anchor.slice(0, 7);
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const MAX = 4;
  return (
    <div style={{ minWidth: 760 }} data-testid="calendar-month">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6, marginBottom: 6 }}>
        {WEEKDAYS_UK.map((w) => (
          <div key={w} style={{ fontSize: 12, fontWeight: 650, color: "var(--muted)", padding: "0 6px" }}>
            {w}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6 }}>
        {days.map((d) => {
          const list = p.byDay.get(d) ?? [];
          const inMonth = d.slice(0, 7) === month;
          const isToday = d === p.today;
          const hol = uaHoliday(d);
          const load = dayLoad(list, p.rowsById);
          const monday = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7 === 0;
          return (
            <div
              key={d}
              data-day={d}
              title={hol ? `🇺🇦 ${hol}` : undefined}
              style={{
                border: `1px solid ${isToday ? "var(--accent)" : load.heavy ? "#ea580c" : "var(--border)"}`,
                borderRadius: 10,
                background: !inMonth ? "transparent" : isWeekend(d) || hol ? "color-mix(in srgb, var(--hover) 70%, var(--surface))" : "var(--surface)",
                minHeight: 112,
                padding: 5,
                display: "flex",
                flexDirection: "column",
                gap: 3,
                opacity: inMonth ? 1 : 0.55,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  type="button"
                  onClick={() => onDay(d)}
                  title="Відкрити тиждень"
                  style={{ border: "none", background: "none", padding: "0 3px", font: "inherit", fontSize: 12.5, fontWeight: 700, color: isToday ? "var(--accent)" : hol || isWeekend(d) ? "var(--err)" : "var(--text)", cursor: "pointer" }}
                >
                  {Number(d.slice(8, 10))}
                </button>
                {monday && <span style={{ fontSize: 9.5, color: "var(--faint)" }} title="Номер тижня">т.{isoWeek(d)}</span>}
                {load.text && <LoadBadge load={load} small />}
              </div>
              {hol && <div style={{ fontSize: 10, color: "var(--err)", lineHeight: 1.2, padding: "0 3px" }}>🇺🇦 {hol}</div>}
              {list.slice(0, MAX).map((e) => (
                <EventChip key={e.id} e={e} row={p.rowsById.get(e.rowId)!} onPick={p.onPick} selected={p.selected === e.rowId} />
              ))}
              {list.length > MAX && (
                <button type="button" onClick={() => onDay(d)} style={{ border: "none", background: "none", padding: "0 4px", textAlign: "left", font: "inherit", fontSize: 11.5, color: "var(--muted)", cursor: "pointer" }}>
                  ще {list.length - MAX}…
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function YearGrid({
  year,
  today,
  byDay,
  rowsById,
  onMonth,
  onDay,
}: {
  year: string;
  today: string;
  byDay: Map<string, CalEvent[]>;
  rowsById: Map<string, CalRow>;
  onMonth: (m: string) => void;
  onDay: (d: string) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }} data-testid="calendar-year">
      {MONTHS_UK.map((name, mi) => {
        const first = `${year}-${String(mi + 1).padStart(2, "0")}-01`;
        const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
        const n = daysInMonth(first);
        const total = Array.from({ length: n }, (_, i) => byDay.get(addDays(first, i))?.length ?? 0).reduce((a, b) => a + b, 0);
        return (
          <div key={name} style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)", padding: 10 }}>
            <button type="button" onClick={() => onMonth(first)} style={{ border: "none", background: "none", padding: 0, font: "inherit", fontWeight: 700, fontSize: 14, color: "var(--text)", cursor: "pointer", display: "flex", gap: 6, alignItems: "baseline" }}>
              {name}
              {total > 0 && <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--muted)" }}>{total} под.</span>}
            </button>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginTop: 6 }}>
              {WEEKDAYS_UK.map((w) => (
                <span key={w} style={{ fontSize: 9.5, color: "var(--faint)", textAlign: "center" }}>
                  {w}
                </span>
              ))}
              {Array.from({ length: lead }, (_, i) => (
                <span key={`l${i}`} />
              ))}
              {Array.from({ length: n }, (_, i) => {
                const d = addDays(first, i);
                const list = byDay.get(d) ?? [];
                const top = list[0];
                return (
                  <button
                    key={d}
                    type="button"
                    data-day={d}
                    onClick={() => onDay(d)}
                    title={yearTitle(d, list, rowsById)}
                    style={{
                      height: 24,
                      border: d === today ? "1.5px solid var(--accent)" : "1px solid transparent",
                      borderRadius: 6,
                      background: top ? `color-mix(in srgb, ${EVENT_META[top.type].color} ${Math.min(22 + list.length * 14, 70)}%, transparent)` : "transparent",
                      color: uaHoliday(d) ? "var(--err)" : isWeekend(d) ? "var(--muted)" : "var(--text)",
                      font: "inherit",
                      fontSize: 11,
                      fontWeight: list.length ? 700 : 400,
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function chipTitle(e: CalEvent, row: CalRow): string {
  return [
    `${EVENT_META[e.type].label}${e.approx ? " (орієнтовно)" : ""}${e.source ? ` · ${e.source}` : ""}`,
    `${CARGO_META[row.cargoType].icon} ${row.product} — ${CARGO_META[row.cargoType].label}`,
    row.forwarder ? `Хто везе: ${row.forwarder}` : "",
    row.number ? `№ ${row.number}${row.carrierName ? ` · ${row.carrierName}` : ""}` : "",
    row.origin || row.destination ? `${row.origin || "—"} → ${row.destination || "—"}` : "",
    `Статус: ${row.statusLabel}`,
    row.logist ? `Логіст: ${row.logist}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * One event on the calendar. Fill + border + mark = event type (orange ↗
 * departure, blue ⚑ planned arrival, yellow ⏱ tracking ETA, teal / violet / green
 * for arrived / cleared / delivered); the bar on the left = who carries it; the
 * icon = cargo type. The tracking number links to the carrier's site.
 */
function EventChip({ e, row, onPick, selected, wide }: { e: CalEvent; row: CalRow; onPick: (id: string) => void; selected: boolean; wide?: boolean }) {
  const color = EVENT_META[e.type].color;
  const bar = row.tab === "warehouse" || !row.forwarder ? color : forwarderColor(row.forwarder);
  const shape = EVENT_SHAPE[e.type];
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="calendar-event"
      data-type={e.type}
      data-cargo={row.cargoType}
      onClick={() => onPick(e.rowId)}
      onKeyDown={(k) => {
        if (k.key === "Enter" || k.key === " ") {
          k.preventDefault();
          onPick(e.rowId);
        }
      }}
      title={chipTitle(e, row)}
      style={{
        display: "block",
        width: "100%",
        boxSizing: "border-box",
        textAlign: "left",
        border: `1.5px ${shape.border} ${color}`,
        borderLeft: `5px solid ${bar}`,
        borderRadius: 6,
        padding: wide ? "5px 7px" : "2px 5px",
        background: selected ? "var(--active)" : `color-mix(in srgb, ${color} 16%, var(--surface))`,
        color: "var(--text)",
        fontSize: wide ? 12.5 : 11.5,
        cursor: "pointer",
        overflow: "hidden",
        whiteSpace: wide ? "normal" : "nowrap",
        textOverflow: "ellipsis",
        opacity: e.approx ? 0.85 : 1,
      }}
    >
      <span aria-hidden style={{ marginRight: 3 }}>
        {CARGO_META[row.cargoType].icon}
      </span>
      {e.type !== "warehouse" && (
        <span aria-hidden style={{ marginRight: 3, color, fontWeight: 700 }}>
          {shape.mark}
        </span>
      )}
      <b style={{ fontWeight: 600 }}>{row.product}</b>
      {e.approx ? " ≈" : ""}
      {row.notesCount > 0 && (
        <span style={{ marginLeft: 4, color: "var(--muted)" }} title={`Нотаток: ${row.notesCount}`}>
          💬{row.notesCount}
        </span>
      )}
      {!wide && row.trackLink && (
        <a
          href={row.trackLink}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(ev) => ev.stopPropagation()}
          title={`Відстежити ${row.number ?? ""} на сайті`}
          style={{ marginLeft: 4, color, textDecoration: "none", fontWeight: 700 }}
          data-testid="calendar-track-link"
        >
          ↗
        </a>
      )}
      {wide && (
        <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)", marginTop: 1 }}>
          {EVENT_META[e.type].label}
          {row.forwarder ? ` · ${row.forwarder}` : ""}
          {row.destination && e.type !== "departure" ? ` · ${row.destination}` : ""}
          {row.origin && e.type === "departure" ? ` · ${row.origin}` : ""}
          {e.source ? ` · ${e.source}` : ""}
        </span>
      )}
      {wide && row.number && (
        <span style={{ display: "block", fontSize: 11.5, marginTop: 2 }}>
          {row.trackLink ? (
            <a
              href={row.trackLink}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(ev) => ev.stopPropagation()}
              style={{ color, fontFamily: "var(--font-mono)", textDecoration: "none" }}
              data-testid="calendar-track-link"
            >
              {row.number} ↗
            </a>
          ) : (
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--muted)" }}>{row.number}</span>
          )}
        </span>
      )}
    </div>
  );
}
