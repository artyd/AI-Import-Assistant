"use client";

// Logist calendar over the team Google Sheet (synced hourly). Week / month / year
// views of every departure, planned arrival, clearance / delivery, tracking ETA and
// БЦ warehouse intake; filters by logist, mode, forwarder, arrival place and status;
// an «Увага» list of rows with data problems; Excel export and a printable plan.
// The sheet is the source of truth — every row links back to it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ListView } from "./ListView";
import { PunctualityPanel } from "./PunctualityPanel";
import { calendarApi, CARGO_META, CARGO_ORDER, EVENT_SHAPE, forwarderColor, isoWeek, sameLogist, EVENT_META, EVENT_ORDER, fmtDay, MODE_LABEL_CAL, shiftAnchor, todayKyiv, viewRange, viewTitle, type CalendarResponse, type CalEvent, type CalEventType, type CalRow, type CalView, type CargoType } from "@/lib/calendar";
import { matchesQuery } from "./load";
import { printPlan } from "./printPlan";
import { quickBtn, AttentionList, SyncBadge, FilterSelect } from "./controls";
import { WeekGrid, MonthGrid, YearGrid } from "./grids";
import { RowDetail, toolBtn } from "./RowDetail";

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

