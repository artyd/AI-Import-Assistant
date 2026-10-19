"use client";
import { useAppStore } from "@/lib/store";
import { NotesBox } from "./NotesBox";
import { type CalRow, type CalEvent, daysFrom, CARGO_META, MODE_LABEL_CAL, fmtDay, forwarderColor, EVENT_META } from "@/lib/calendar";
import { closeBtn } from "./controls";

// ── Side panels ──────────────────────────────────────────────────────────────

export function RowDetail({
  row,
  events,
  today,
  onClose,
  onNotes,
}: {
  row: CalRow;
  events: CalEvent[];
  today: string;
  onClose: () => void;
  onNotes?: (n: number) => void;
}) {
  const setView = useAppStore((s) => s.setView);
  const setFocusTrackId = useAppStore((s) => s.setFocusTrackId);
  const left = row.arrival && !["customs", "delivered"].includes(row.status) ? daysFrom(today, row.arrival.date) : null;
  const facts: Array<[string, string]> = [
    ["Тип", `${CARGO_META[row.cargoType].icon} ${CARGO_META[row.cargoType].label}`],
    ["Хто везе", row.forwarder],
    ["Вид", row.mode ? (MODE_LABEL_CAL[row.mode] ?? row.mode) : ""],
    ["Звідки", row.origin],
    ["Куди", row.destination],
    ["Вихід", row.departure ? fmtDay(row.departure.date) : ""],
    ["Прибуття (план)", row.arrival ? fmtDay(row.arrival.date) : ""],
    ["Кількість", row.qty ?? ""],
    ["Коли (склад)", row.when ?? ""],
    ["Вміститься в БЦ", row.fits ?? ""],
    ["Кількість", row.weight],
    ["Лінія", row.line],
    ["Логіст", row.logist],
    ["Місце розмитнення", row.customsPlace],
    ["Склад", row.warehouse],
    ["№ заявки", row.refNo],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>
            {row.tab === "warehouse" ? "Склад БЦ" : "Таблиця"} · рядок {row.rowIndex}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, overflowWrap: "anywhere" }}>{row.product}</div>
          <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={statusPill}>{row.statusLabel}</span>
            {left != null && (
              <span style={{ fontSize: 12.5, fontWeight: 600, color: left < 0 ? "var(--err)" : "var(--text)" }} data-testid="calendar-countdown">
                {left < 0 ? `план минув ${-left} дн тому` : left === 0 ? "прибуття сьогодні" : `до прибуття ${left} дн`}
              </span>
            )}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Закрити" style={closeBtn}>
          ×
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "grid", gap: 14, alignContent: "start" }}>
        {row.issues.length > 0 && (
          <section style={{ padding: 10, borderRadius: 10, background: "color-mix(in srgb, var(--err) 10%, transparent)", fontSize: 12.5, display: "grid", gap: 3 }}>
            {row.issues.map((i) => (
              <div key={i.code}>⚠ {i.label}</div>
            ))}
          </section>
        )}
        {row.number && (
          <section
            style={{ padding: 10, borderRadius: 10, border: `1px solid ${forwarderColor(row.forwarder)}`, display: "grid", gap: 6 }}
            data-testid="calendar-track"
          >
            <div style={{ fontSize: 11, fontWeight: 650, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>
              Трек-номер{row.carrierName ? ` · ${row.carrierName}` : ""}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{row.number}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {row.trackLink && (
                <a
                  className="btn btn-primary"
                  href={row.trackLink}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ ...toolBtn, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                >
                  Відстежити на сайті ↗
                </a>
              )}
              <button type="button" className="btn" style={toolBtn} onClick={() => void navigator.clipboard?.writeText(row.number ?? "")}>
                Копіювати
              </button>
            </div>
          </section>
        )}
        <section style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 13 }}>
          {facts
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <span style={{ color: "var(--muted)" }}>{k}</span>
                <span style={{ overflowWrap: "anywhere" }}>{v}</span>
              </div>
            ))}
        </section>
        {row.freeTime && (
          <section
            data-testid="calendar-freetime"
            style={{
              padding: 10,
              borderRadius: 10,
              fontSize: 12.5,
              background: `color-mix(in srgb, ${EVENT_META.free_end.color} ${daysFrom(today, row.freeTime.end) <= 2 ? 16 : 7}%, transparent)`,
            }}
          >
            ⏳ Безкоштовне зберігання: {fmtDay(row.freeTime.start).slice(0, 5)} → <b>{fmtDay(row.freeTime.end)}</b> ({row.freeTime.days} дн,{" "}
            {row.freeTime.source === "sheet" ? "з таблиці" : row.freeTime.source === "line" ? "за лінією" : "за замовчуванням"}
            {row.freeTime.fromActual ? "" : ", від плану прибуття"})
            <div style={{ fontWeight: 650, marginTop: 2, color: daysFrom(today, row.freeTime.end) < 0 ? "var(--err)" : undefined }}>
              {daysFrom(today, row.freeTime.end) < 0
                ? `Демередж уже ${-daysFrom(today, row.freeTime.end)} дн`
                : daysFrom(today, row.freeTime.end) === 0
                  ? "Сьогодні останній безкоштовний день"
                  : `Залишилось ${daysFrom(today, row.freeTime.end)} дн`}
            </div>
          </section>
        )}
        {row.track && (
          <section style={{ padding: 10, borderRadius: 10, background: "var(--hover)", fontSize: 12.5 }}>
            🧭 Трекінг у хабі: <b>{row.track.statusLabel}</b>
            {row.track.eta ? ` · ETA ${fmtDay(row.track.eta.slice(0, 10))}` : ""}
          </section>
        )}
        {events.length > 0 && (
          <section>
            <div style={sectionLabel}>Події</div>
            <div style={{ display: "grid", gap: 4 }}>
              {[...events]
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((e) => (
                  <div key={e.id} style={{ display: "flex", gap: 8, fontSize: 12.5, alignItems: "center" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 3, background: EVENT_META[e.type].color, flex: "none" }} />
                    <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 78 }}>
                      {fmtDay(e.date)}
                      {e.approx ? " ≈" : ""}
                    </span>
                    <span>
                      {EVENT_META[e.type].label}
                      {e.source ? ` · ${e.source}` : ""}
                    </span>
                  </div>
                ))}
            </div>
          </section>
        )}
        {row.tab === "tracking" && <NotesBox rowId={row.id} onCount={onNotes} />}
        {row.comment && (
          <section>
            <div style={sectionLabel}>Коментар</div>
            <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.comment}</div>
          </section>
        )}
      </div>
      {(row.url || row.trackedId) && (
        <div style={{ padding: 12, borderTop: "1px solid var(--border)", display: "grid", gap: 6 }}>
          {row.trackedId && (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="calendar-show-on-map"
              style={{ ...toolBtn, width: "100%", justifyContent: "center", display: "inline-flex", alignItems: "center" }}
              onClick={() => {
                setFocusTrackId(row.trackedId);
                setView("map");
              }}
            >
              🗺 Показати на карті
            </button>
          )}
          {row.url && (
            <a className="btn" href={row.url} target="_blank" rel="noreferrer noopener" style={{ ...toolBtn, width: "100%", justifyContent: "center", textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              Відкрити рядок у таблиці ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}
export const toolBtn: React.CSSProperties = { height: 32, padding: "0 11px", fontSize: 12.5, whiteSpace: "nowrap" };
const statusPill: React.CSSProperties = { fontSize: 12, fontWeight: 600, padding: "2px 9px", borderRadius: 999, background: "var(--hover)" };
const sectionLabel: React.CSSProperties = { fontSize: 11, fontWeight: 650, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 };
