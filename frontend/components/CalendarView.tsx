"use client";

// Logist calendar over the team Google Sheet (synced hourly). Week / month / year
// views of every departure, planned arrival, clearance / delivery, tracking ETA and
// БЦ warehouse intake; filters by logist, mode, forwarder, arrival place and status;
// an «Увага» list of rows with data problems; Excel export and a printable plan.
// The sheet is the source of truth — every row links back to it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { ListView } from "./calendar/ListView";
import { NotesBox } from "./calendar/NotesBox";
import { PunctualityPanel } from "./calendar/PunctualityPanel";
import {
  addDays,
  calendarApi,
  CARGO_META,
  CARGO_ORDER,
  EVENT_SHAPE,
  forwarderColor,
  isoWeek,
  isWeekend,
  sameLogist,
  uaHoliday,
  daysFrom,
  daysInMonth,
  EVENT_META,
  EVENT_ORDER,
  fmtDay,
  MODE_LABEL_CAL,
  MONTHS_UK,
  shiftAnchor,
  todayKyiv,
  viewRange,
  viewTitle,
  WEEKDAYS_UK,
  type CalendarResponse,
  type CalEvent,
  type CalEventType,
  type CalRow,
  type CalView,
  type CargoType,
  type SyncInfo,
} from "@/lib/calendar";

interface Filters {
  type: string;
  logist: string;
  mode: string;
  forwarder: string;
  place: string;
  status: string;
}
const NO_FILTERS: Filters = { type: "", logist: "", mode: "", forwarder: "", place: "", status: "" };

const VIEW_KEY = "aia_calendar_view";

function loadView(): CalView {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return v === "list" || v === "week" || v === "month" || v === "year" ? v : "month";
  } catch {
    return "month";
  }
}

export function CalendarView() {
  const today = todayKyiv();
  const [view, setView] = useState<CalView>("month");
  const [anchor, setAnchor] = useState(today);
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [hidden, setHidden] = useState<Set<CalEventType>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [attention, setAttention] = useState<CalRow[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { user } = useAuth();
  // Search (product / number / forwarder / place) + one-click quick filters.
  const [query, setQuery] = useState("");
  const [hitsOpen, setHitsOpen] = useState(false);
  const [quick, setQuick] = useState<"mine" | "late" | null>(null);
  const [panel, setPanel] = useState<"attention" | "punctuality" | null>(null);
  const [attentionCode, setAttentionCode] = useState<string | null>(null);
  const [yearRows, setYearRows] = useState<{ year: string; data: CalendarResponse } | null>(null);
  const [notesBump, setNotesBump] = useState<Record<string, number>>({});

  useEffect(() => setView(loadView()), []);
  const chooseView = (v: CalView) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  };

  const [from, to] = viewRange(view, anchor);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    calendarApi
      .range(from, to)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Не вдалося завантажити календар."))
      .finally(() => setLoading(false));
    calendarApi
      .attention()
      .then((r) => setAttention(r.rows))
      .catch(() => setAttention([]));
  }, [from, to]);

  useEffect(load, [load]);

  const rowsById = useMemo(() => new Map((data?.rows ?? []).map((r) => [r.id, r])), [data]);

  const facets = useMemo(() => {
    const rows = data?.rows ?? [];
    const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, "uk"));
    return {
      logist: uniq(rows.map((r) => r.logist)),
      mode: uniq(rows.map((r) => r.mode ?? "")),
      forwarder: uniq(rows.map((r) => r.forwarder)),
      place: uniq(rows.map((r) => r.destination)),
      status: uniq(rows.map((r) => r.statusLabel)),
      type: CARGO_ORDER.filter((t) => rows.some((r) => r.cargoType === t)),
    };
  }, [data]);

  const rowPasses = useCallback(
    (r: CalRow) =>
      (!filters.logist || r.logist === filters.logist) &&
      (!filters.mode || r.mode === filters.mode) &&
      (!filters.forwarder || r.forwarder === filters.forwarder) &&
      (!filters.place || r.destination === filters.place) &&
      (!filters.status || r.statusLabel === filters.status) &&
      (!filters.type || r.cargoType === filters.type),
    [filters]
  );

  const quickPasses = useCallback(
    (r: CalRow) =>
      quick === "mine"
        ? !!user?.name && sameLogist(r.logist, user.name)
        : quick === "late"
          ? r.issues.some((i) => ["overdue", "tracking_eta", "tracking_delivered"].includes(i.code))
          : true,
    [quick, user]
  );

  // Search across the whole year: matches with their nearest date, to jump to.
  useEffect(() => {
    const y = anchor.slice(0, 4);
    if (query.trim().length < 2 || yearRows?.year === y) return;
    calendarApi
      .range(`${y}-01-01`, `${y}-12-31`)
      .then((d) => setYearRows({ year: y, data: d }))
      .catch(() => undefined);
  }, [query, anchor, yearRows]);
  const searchHits = useMemo(() => {
    if (query.trim().length < 2 || !yearRows) return [];
    const byRow = new Map<string, CalEvent[]>();
    for (const e of yearRows.data.events) byRow.set(e.rowId, [...(byRow.get(e.rowId) ?? []), e]);
    return yearRows.data.rows
      .filter((r) => matchesQuery(r, query))
      .map((r) => {
        const evs = (byRow.get(r.id) ?? []).sort((a, b) => a.date.localeCompare(b.date));
        const next = evs.find((e) => e.date >= today) ?? evs[evs.length - 1];
        return { r, e: next };
      })
      .filter((x): x is { r: CalRow; e: CalEvent } => !!x.e)
      .sort((a, b) => Math.abs(Date.parse(a.e.date) - Date.parse(today)) - Math.abs(Date.parse(b.e.date) - Date.parse(today)))
      .slice(0, 8);
  }, [query, yearRows, today]);

  const events = useMemo(
    () =>
      (data?.events ?? []).filter((e) => {
        const r = rowsById.get(e.rowId);
        return r && !hidden.has(e.type) && rowPasses(r) && matchesQuery(r, query) && quickPasses(r);
      }),
    [data, rowsById, hidden, rowPasses, query, quickPasses]
  );

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return m;
  }, [events]);

  async function syncNow() {
    setSyncing(true);
    setNote(null);
    try {
      await calendarApi.sync();
      load();
      setNote("Таблицю оновлено.");
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : "Не вдалося оновити таблицю.");
    } finally {
      setSyncing(false);
    }
  }

  const selRaw = selected
    ? (rowsById.get(selected) ?? yearRows?.data.rows.find((r) => r.id === selected) ?? attention?.find((r) => r.id === selected) ?? null)
    : null;
  const sel = selRaw && notesBump[selRaw.id] != null ? { ...selRaw, notesCount: notesBump[selRaw.id]! } : selRaw;
  const filtered = Object.values(filters).some(Boolean) || !!quick || !!query;
  const resetAll = () => {
    setHitsOpen(false);
    setFilters(NO_FILTERS);
    setQuick(null);
    setQuery("");
  };
  const arrivalsThisWeek = () => {
    setQuick(null);
    setAnchor(today);
    chooseView("week");
    setHidden(new Set(EVENT_ORDER.filter((t) => !["arrival", "arrived", "eta"].includes(t))));
  };

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }} data-testid="calendar">
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {/* Toolbar */}
        <div style={{ padding: "12px 16px 8px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", gap: 4 }}>
            <button type="button" className="btn" style={iconBtn} onClick={() => setAnchor(shiftAnchor(view, anchor, -1))} aria-label="Попередній період">
              ‹
            </button>
            <button type="button" className="btn" style={{ ...iconBtn, width: "auto", padding: "0 12px" }} onClick={() => setAnchor(today)}>
              Сьогодні
            </button>
            <button type="button" className="btn" style={iconBtn} onClick={() => setAnchor(shiftAnchor(view, anchor, 1))} aria-label="Наступний період">
              ›
            </button>
          </div>
          <h2 style={{ margin: "0 6px", fontSize: 18, fontWeight: 700, minWidth: 180 }} data-testid="calendar-title">
            {viewTitle(view, anchor)}
            {view === "week" && <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--muted)", marginLeft: 8 }}>тиждень {isoWeek(anchor)}</span>}
          </h2>
          <div role="tablist" aria-label="Вигляд календаря" style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            {(["list", "week", "month", "year"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => chooseView(v)}
                style={{
                  height: 32,
                  padding: "0 14px",
                  border: "none",
                  background: view === v ? "var(--accent)" : "var(--surface)",
                  color: view === v ? "var(--accentTx)" : "var(--text)",
                  font: "inherit",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {v === "list" ? "Список" : v === "week" ? "Тиждень" : v === "month" ? "Місяць" : "Рік"}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <SyncBadge sync={data?.sync ?? null} />
          <button type="button" className="btn" style={toolBtn} onClick={() => void syncNow()} disabled={syncing} title="Прочитати таблицю зараз">
            {syncing ? "Оновлюю…" : "↻ Оновити"}
          </button>
          {data?.sync.sheetUrl && (
            <a className="btn" style={{ ...toolBtn, textDecoration: "none" }} href={data.sync.sheetUrl} target="_blank" rel="noreferrer noopener">
              Таблиця ↗
            </a>
          )}
          <button type="button" className="btn" style={toolBtn} onClick={() => void calendarApi.exportXlsx(from, to)} title="Події періоду в Excel">
            Excel
          </button>
          <button type="button" className="btn" style={toolBtn} onClick={() => printPlan(viewTitle(view, anchor), events, rowsById)} title="Друк або збереження в PDF">
            Друк / PDF
          </button>
          <button
            type="button"
            className="btn"
            data-testid="calendar-attention-toggle"
            onClick={() => {
              setAttentionCode(null);
              setPanel((p) => (p === "attention" ? null : "attention"));
            }}
            style={{
              ...toolBtn,
              borderColor: panel === "attention" ? "var(--err)" : undefined,
              color: (attention?.length ?? 0) > 0 ? "var(--err)" : undefined,
            }}
          >
            ⚠ Увага {attention?.length ?? ""}
          </button>
          <button
            type="button"
            className="btn"
            data-testid="calendar-punctuality-toggle"
            onClick={() => setPanel((p) => (p === "punctuality" ? null : "punctuality"))}
            style={{ ...toolBtn, borderColor: panel === "punctuality" ? "var(--accent)" : undefined }}
          >
            📊 Пунктуальність
          </button>
        </div>

        {/* Search + quick filters */}
        <div style={{ padding: "8px 16px 0", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "0 1 320px", minWidth: 200 }}>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHitsOpen(true);
              }}
              onFocus={() => setHitsOpen(true)}
              onKeyDown={(e) => e.key === "Escape" && setHitsOpen(false)}
              placeholder="🔍 Пошук: товар, номер, хто везе, місце…"
              aria-label="Пошук у календарі"
              data-testid="calendar-search"
              style={{ width: "100%", boxSizing: "border-box", height: 32, borderRadius: 9, border: `1px solid ${query ? "var(--accent)" : "var(--border)"}`, background: "var(--surface)", color: "var(--text)", font: "inherit", fontSize: 13, padding: "0 10px" }}
            />
            {hitsOpen && searchHits.length > 0 && (
              <div
                style={{ position: "absolute", top: 36, left: 0, right: 0, zIndex: 20, border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", boxShadow: "var(--shadow)", overflow: "hidden" }}
                data-testid="calendar-search-hits"
              >
                {searchHits.map(({ r, e }) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setAnchor(e.date);
                      chooseView("week");
                      setSelected(r.id);
                      setHitsOpen(false);
                    }}
                    style={{ display: "flex", width: "100%", gap: 8, alignItems: "center", padding: "6px 10px", border: "none", borderBottom: "1px solid var(--border)", background: "none", color: "var(--text)", font: "inherit", fontSize: 12.5, textAlign: "left", cursor: "pointer" }}
                  >
                    <span aria-hidden>{CARGO_META[r.cargoType].icon}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <b>{r.product}</b>
                      {r.number ? <span style={{ color: "var(--muted)" }}> · {r.number}</span> : null}
                    </span>
                    <span style={{ color: EVENT_META[e.type].color, whiteSpace: "nowrap" }}>
                      {EVENT_META[e.type].icon} {fmtDay(e.date).slice(0, 5)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }} aria-label="Швидкі фільтри">
            <button type="button" aria-pressed={quick === "mine"} onClick={() => setQuick((q) => (q === "mine" ? null : "mine"))} style={quickBtn(quick === "mine")} title={user?.name ? `Логіст у таблиці = ${user.name}` : "Вкажіть імʼя у профілі"}>
              👤 Мої
            </button>
            <button type="button" onClick={arrivalsThisWeek} style={quickBtn(false)}>
              ⚓ Прибуває цього тижня
            </button>
            <button type="button" aria-pressed={quick === "late"} onClick={() => setQuick((q) => (q === "late" ? null : "late"))} style={quickBtn(quick === "late")}>
              ⚠ Запізнюються
            </button>
            <button
              type="button"
              onClick={() => {
                setAttentionCode("no_dates");
                setPanel("attention");
              }}
              style={quickBtn(false)}
            >
              📭 Без дат
            </button>
          </div>
        </div>

        {/* Filters + legend */}
        <div style={{ padding: "8px 16px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", borderBottom: "1px solid var(--border)" }}>
          <FilterSelect
            label="Тип"
            value={filters.type}
            options={facets.type}
            format={(v) => `${CARGO_META[v as CargoType]?.icon ?? ""} ${CARGO_META[v as CargoType]?.label ?? v}`}
            onChange={(v) => setFilters((f) => ({ ...f, type: v }))}
          />
          <FilterSelect label="Хто везе" value={filters.forwarder} options={facets.forwarder} onChange={(v) => setFilters((f) => ({ ...f, forwarder: v }))} />
          <FilterSelect label="Логіст" value={filters.logist} options={facets.logist} onChange={(v) => setFilters((f) => ({ ...f, logist: v }))} />
          <FilterSelect
            label="Вид"
            value={filters.mode}
            options={facets.mode}
            format={(v) => MODE_LABEL_CAL[v] ?? v}
            onChange={(v) => setFilters((f) => ({ ...f, mode: v }))}
          />
          <FilterSelect label="Куди" value={filters.place} options={facets.place} onChange={(v) => setFilters((f) => ({ ...f, place: v }))} />
          <FilterSelect label="Статус" value={filters.status} options={facets.status} onChange={(v) => setFilters((f) => ({ ...f, status: v }))} />
          {filtered && (
            <button type="button" className="btn" style={{ ...toolBtn, height: 28 }} onClick={resetAll}>
              Скинути
            </button>
          )}
        </div>

        {/* Legend: colour = who carries (click = filter), icon = cargo type, shape = event */}
        <div
          style={{ padding: "6px 16px 8px", display: "flex", alignItems: "center", gap: "4px 14px", flexWrap: "wrap", borderBottom: "1px solid var(--border)", fontSize: 12 }}
          data-testid="calendar-legend"
        >
          {facets.forwarder.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }} aria-label="Хто везе">
              <span style={legendLabel} title="Колір смужки зліва на мітці">Хто везе (смужка):</span>
              {facets.forwarder.map((fw) => (
                <button
                  key={fw}
                  type="button"
                  aria-pressed={filters.forwarder === fw}
                  onClick={() => setFilters((f) => ({ ...f, forwarder: f.forwarder === fw ? "" : fw }))}
                  style={{ ...legendChip, borderColor: filters.forwarder === fw ? forwarderColor(fw) : "var(--border)" }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: forwarderColor(fw) }} />
                  {fw}
                </button>
              ))}
            </div>
          )}
          {facets.type.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }} aria-label="Типи вантажу">
              <span style={legendLabel}>Тип:</span>
              {facets.type.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={filters.type === t}
                  onClick={() => setFilters((f) => ({ ...f, type: f.type === t ? "" : t }))}
                  style={{ ...legendChip, borderColor: filters.type === t ? "var(--accent)" : "var(--border)" }}
                >
                  <span aria-hidden>{CARGO_META[t].icon}</span>
                  {CARGO_META[t].label}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }} aria-label="Типи подій">
            <span style={legendLabel}>Події:</span>
            {EVENT_ORDER.map((t) => {
              const off = hidden.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={!off}
                  onClick={() =>
                    setHidden((h) => {
                      const n = new Set(h);
                      if (n.has(t)) n.delete(t);
                      else n.add(t);
                      return n;
                    })
                  }
                  style={{ ...legendChip, opacity: off ? 0.4 : 1 }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 14,
                      height: 10,
                      borderRadius: 3,
                      border: `2px ${EVENT_SHAPE[t].border} ${EVENT_META[t].color}`,
                      background: `color-mix(in srgb, ${EVENT_META[t].color} 25%, transparent)`,
                    }}
                  />
                  {EVENT_SHAPE[t].mark} {EVENT_META[t].label}
                </button>
              );
            })}
          </div>
        </div>

        {note && <div style={{ padding: "6px 16px", fontSize: 12.5, color: "var(--muted)" }}>{note}</div>}
        {error && (
          <div role="alert" style={{ padding: "8px 16px", fontSize: 13, color: "var(--err)" }}>
            {error}
          </div>
        )}
        {data && !data.sync.enabled && (
          <div style={{ padding: "8px 16px", fontSize: 13, color: "var(--muted)" }}>
            Робочу таблицю ще не підключено (SHEET_ID у налаштуваннях сервера).
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12, opacity: loading ? 0.6 : 1, transition: "opacity .15s" }}>
          {view === "list" ? (
            <ListView events={events} rowsById={rowsById} today={today} selected={selected} onPick={setSelected} />
          ) : view === "week" ? (
            <WeekGrid from={from} today={today} byDay={byDay} rowsById={rowsById} onPick={setSelected} selected={selected} />
          ) : view === "month" ? (
            <MonthGrid from={from} anchor={anchor} today={today} byDay={byDay} rowsById={rowsById} onPick={setSelected} selected={selected} onDay={(d) => { setAnchor(d); chooseView("week"); }} />
          ) : (
            <YearGrid year={anchor.slice(0, 4)} today={today} byDay={byDay} rowsById={rowsById} onMonth={(m) => { setAnchor(m); chooseView("month"); }} onDay={(d) => { setAnchor(d); chooseView("week"); }} />
          )}
          {!loading && data && events.length === 0 && (
            <p style={{ textAlign: "center", color: "var(--muted)", fontSize: 13, marginTop: 24 }}>
              {filtered || hidden.size ? "За цими фільтрами подій немає." : "Подій за цей період у таблиці немає."}
            </p>
          )}
        </div>
      </div>

      {(sel || panel) && (
        <aside
          style={{ width: 360, flex: "none", borderLeft: "1px solid var(--border)", background: "var(--surface)", display: "flex", flexDirection: "column", minHeight: 0 }}
          data-testid={sel ? "calendar-detail" : panel === "punctuality" ? "calendar-punctuality-panel" : "calendar-attention"}
        >
          {sel ? (
            <RowDetail
              row={sel}
              events={[...(data?.events ?? []), ...(yearRows?.data.events ?? [])].filter((e, i, all) => e.rowId === sel.id && all.findIndex((x) => x.id === e.id) === i)}
              today={today}
              onClose={() => setSelected(null)}
              onNotes={(n) => setNotesBump((b) => ({ ...b, [sel.id]: n }))}
            />
          ) : panel === "punctuality" ? (
            <PunctualityPanel
              onClose={() => setPanel(null)}
              onForwarder={(f) => setFilters((x) => ({ ...x, forwarder: f }))}
            />
          ) : (
            <AttentionList
              rows={(attention ?? []).filter((r) => !attentionCode || r.issues.some((i) => i.code === attentionCode))}
              title={attentionCode === "no_dates" ? "📭 Без дат" : undefined}
              onPick={setSelected}
              onClose={() => setPanel(null)}
            />
          )}
        </aside>
      )}
    </div>
  );
}

// ── Views ────────────────────────────────────────────────────────────────────

interface GridProps {
  today: string;
  byDay: Map<string, CalEvent[]>;
  rowsById: Map<string, CalRow>;
  onPick: (rowId: string) => void;
  selected: string | null;
}

function WeekGrid({ from, ...p }: GridProps & { from: string }) {
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

function MonthGrid({ from, anchor, onDay, ...p }: GridProps & { from: string; anchor: string; onDay: (d: string) => void }) {
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

function YearGrid({
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

// ── Search / load / year tooltip helpers ─────────────────────────────────────

function matchesQuery(r: CalRow, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return [r.product, r.number ?? "", r.forwarder, r.destination, r.origin, r.carrierName ?? ""].some((x) => x.toLowerCase().includes(t));
}

interface Load {
  containers: number;
  air: number;
  parcels: number;
  heavy: boolean;
  text: string;
  title: string;
}

/** Day threshold above which a day is highlighted as busy. */
const HEAVY_CONTAINERS = 3;
const HEAVY_TOTAL = 6;

/** What physically arrives that day (planned / actual / tracking ETA), by kind and place. */
function dayLoad(list: CalEvent[], rowsById: Map<string, CalRow>): Load {
  const seen = new Set<string>();
  let containers = 0;
  let air = 0;
  let parcels = 0;
  const places = new Map<string, number>();
  for (const e of list) {
    if (!["arrival", "arrived", "eta"].includes(e.type) || seen.has(e.rowId)) continue;
    const r = rowsById.get(e.rowId);
    if (!r) continue;
    seen.add(e.rowId);
    if (["fcl", "groupage", "lcl"].includes(r.cargoType)) containers += 1;
    else if (r.cargoType === "air") air += 1;
    else parcels += 1;
    const pl = r.destination || "—";
    places.set(pl, (places.get(pl) ?? 0) + 1);
  }
  const total = containers + air + parcels;
  const text = [containers ? `🚢${containers}` : "", air ? `✈️${air}` : "", parcels ? `📮${parcels}` : ""].filter(Boolean).join(" ");
  const title = total
    ? `Прибуває: ${total} (контейнери ${containers}, авіа ${air}, посилки ${parcels})\n${[...places.entries()].map(([k, v]) => `${k}: ${v}`).join("\n")}`
    : "";
  return { containers, air, parcels, heavy: containers >= HEAVY_CONTAINERS || total >= HEAVY_TOTAL, text, title };
}

function LoadBadge({ load, small }: { load: Load; small?: boolean }) {
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

function yearTitle(d: string, list: CalEvent[], rowsById: Map<string, CalRow>): string {
  const head = `${fmtDay(d)}${uaHoliday(d) ? ` · ${uaHoliday(d)}` : ""}`;
  if (!list.length) return head;
  const lines = list.slice(0, 10).map((e) => `${EVENT_META[e.type].icon} ${rowsById.get(e.rowId)?.product ?? ""} — ${EVENT_META[e.type].label}`);
  return [head, ...lines, list.length > 10 ? `… ще ${list.length - 10}` : ""].filter(Boolean).join("\n");
}

function quickBtn(active: boolean): React.CSSProperties {
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

// ── Side panels ──────────────────────────────────────────────────────────────

function RowDetail({
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

function AttentionList({ rows, title, onPick, onClose }: { rows: CalRow[]; title?: string; onPick: (id: string) => void; onClose: () => void }) {
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

function SyncBadge({ sync }: { sync: SyncInfo | null }) {
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

function FilterSelect({
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

// ── Print ────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A clean printable plan of the visible events (the browser saves it as PDF). */
function printPlan(title: string, events: CalEvent[], rowsById: Map<string, CalRow>) {
  const w = window.open("", "_blank");
  if (!w) return;
  const rows = events
    .map((e) => {
      const r = rowsById.get(e.rowId);
      if (!r) return "";
      const num = r.number ? (r.trackLink ? `<a href="${esc(r.trackLink)}">${esc(r.number)}</a>` : esc(r.number)) : "";
      return `<tr><td>${fmtDay(e.date)}${e.approx ? " ≈" : ""}</td><td>${esc(EVENT_META[e.type].label)}${e.source ? ` (${esc(e.source)})` : ""}</td><td>${esc(CARGO_META[r.cargoType].label)}</td><td><b>${esc(r.product)}</b></td><td>${num}</td><td>${esc([r.origin, r.destination].filter(Boolean).join(" → "))}</td><td>${esc(r.forwarder)}</td><td>${esc(r.logist)}</td><td>${esc(r.statusLabel)}</td></tr>`;
    })
    .join("");
  w.document.write(`<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Календар логістів — ${esc(title)}</title>
<style>body{font:13px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:18px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f1f5f9}</style></head>
<body><h1>Календар логістів — ${esc(title)}</h1><table><thead><tr><th>Дата</th><th>Подія</th><th>Тип</th><th>Товар</th><th>Трек-номер</th><th>Маршрут</th><th>Хто везе</th><th>Логіст</th><th>Статус</th></tr></thead><tbody>${rows}</tbody></table>
<p style="color:#666;font-size:11px">«≈» — рік у таблиці не вказано або дата орієнтовна. Джерело: робоча таблиця.</p></body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

// ── Styles ───────────────────────────────────────────────────────────────────

const legendLabel: React.CSSProperties = { color: "var(--muted)", fontWeight: 600, marginRight: 2 };
const legendChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  height: 24,
  padding: "0 8px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
};
const iconBtn: React.CSSProperties = { width: 32, height: 32, padding: 0, fontSize: 16, display: "inline-flex", alignItems: "center", justifyContent: "center" };
const toolBtn: React.CSSProperties = { height: 32, padding: "0 11px", fontSize: 12.5, whiteSpace: "nowrap" };
const statusPill: React.CSSProperties = { fontSize: 12, fontWeight: 600, padding: "2px 9px", borderRadius: 999, background: "var(--hover)" };
const sectionLabel: React.CSSProperties = { fontSize: 11, fontWeight: 650, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 };
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

