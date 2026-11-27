"use client";

// Logist calendar over the team Google Sheet (synced hourly). Week / month / year
// views of every departure, planned arrival, clearance / delivery, tracking ETA and
// БЦ warehouse intake; filters by logist, mode, forwarder, arrival place and status;
// an «Увага» list of rows with data problems; Excel export and a printable plan.
// The sheet is the source of truth — every row links back to it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ListView } from "./ListView";
import { PunctualityPanel } from "./PunctualityPanel";
import { calendarApi, CARGO_META, CARGO_ORDER, EVENT_SHAPE, forwarderColor, isoWeek, sameLogist, EVENT_META, EVENT_ORDER, fmtDay, MODE_LABEL_CAL, shiftAnchor, todayKyiv, viewRange, viewTitle, type CalendarResponse, type CalEvent, type CalEventType, type CalRow, type CalView, type CargoType } from "@/lib/calendar";
import { matchesQuery } from "./load";
import { printPlan } from "./printPlan";
import { AttentionList, SyncBadge } from "./controls";
import { Dropdown, type DropdownOption } from "@/components/ui/Dropdown";
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
      count: (key: "logist" | "mode" | "forwarder" | "destination" | "statusLabel" | "cargoType", v: string) => rows.filter((r) => (r[key] ?? "") === v).length,
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
          <Dropdown
            value=""
            placeholder="Експорт"
            activeTint={false}
            testId="cal-export"
            menuWidth={250}
            style={{ height: 32 }}
            onChange={(v) => {
              if (v === "sheet" && data?.sync.sheetUrl) window.open(data.sync.sheetUrl, "_blank", "noopener,noreferrer");
              else if (v === "excel") void calendarApi.exportXlsx(from, to);
              else if (v === "print") printPlan(viewTitle(view, anchor), events, rowsById);
            }}
            options={[
              ...(data?.sync.sheetUrl ? [{ value: "sheet", label: "Відкрити таблицю", icon: "↗", hint: "Робоча Google-таблиця команди" }] : []),
              { value: "excel", label: "Excel", icon: "📊", hint: "Події показаного періоду" },
              { value: "print", label: "Друк / PDF", icon: "🖨", hint: "План на період для друку" },
            ]}
          />
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

        {/* One row: search, quick views, the main filters, the rest under «Ще» */}
        <div
          style={{ padding: "8px 16px", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", borderBottom: "1px solid var(--border)" }}
          data-testid="calendar-filters"
        >
          <div style={{ position: "relative", flex: "1 1 200px", minWidth: 160, maxWidth: 360 }}>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHitsOpen(true);
              }}
              onFocus={() => setHitsOpen(true)}
              onKeyDown={(e) => e.key === "Escape" && setHitsOpen(false)}
              placeholder="🔍 Пошук: товар, номер, місце…"
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
          {(() => {
            const all = (label = "усі"): DropdownOption => ({ value: "", label });
            const opts = (vals: string[], key: Parameters<typeof facets.count>[0], extra?: (v: string) => Partial<DropdownOption>): DropdownOption[] => [
              all(),
              ...vals.map((v) => ({ value: v, label: v, count: facets.count(key, v), ...extra?.(v) })),
            ];
            const set = (k: keyof Filters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
            const shownEvents = EVENT_ORDER.filter((t) => !hidden.has(t));
            const more = [filters.mode, filters.place, filters.status].filter(Boolean).length;
            return (
              <>
                <Dropdown
                  size="sm"
                  compact
                  label="Швидко"
                  value={quick ?? ""}
                  testId="cal-f-quick"
                  menuWidth={270}
                  onChange={(v) => {
                    if (v === "week") arrivalsThisWeek();
                    else if (v === "nodates") {
                      setAttentionCode("no_dates");
                      setPanel("attention");
                    } else setQuick(v ? (v as "mine" | "late") : null);
                  }}
                  options={[
                    { value: "", label: "Усе", icon: "▦" },
                    { value: "mine", label: "Мої", icon: "👤", hint: user?.name ? `Логіст у таблиці = ${user.name}` : "Вкажіть імʼя у профілі" },
                    { value: "late", label: "Запізнюються", icon: "⚠️", hint: "План минув або трекінг показує пізніше" },
                    { value: "week", label: "Прибуває цього тижня", icon: "⚓", hint: "Тиждень, лише прибуття" },
                    { value: "nodates", label: "Без дат", icon: "📭", hint: "Рядки таблиці без жодної дати" },
                  ]}
                />
                <Dropdown
                  size="sm"
                  compact
                  label="Хто везе"
                  value={filters.forwarder}
                  onChange={set("forwarder")}
                  testId="cal-f-forwarder"
                  title="Колір смужки зліва на мітці = хто везе"
                  options={opts(facets.forwarder, "forwarder", (v) => ({ color: forwarderColor(v) }))}
                />
                <Dropdown size="sm" compact label="Логіст" value={filters.logist} onChange={set("logist")} testId="cal-f-logist" options={opts(facets.logist, "logist")} />
                <Dropdown size="sm" compact label="Тип" value={filters.type} onChange={set("type")} testId="cal-f-type" options={opts(facets.type, "cargoType", (v) => ({ label: CARGO_META[v as CargoType]?.label ?? v, icon: CARGO_META[v as CargoType]?.icon }))} />
                <Dropdown
                  size="sm"
                  compact
                  multiple
                  label="Події"
                  allLabel="усі події"
                  values={shownEvents.length === EVENT_ORDER.length ? [] : shownEvents}
                  onChange={(v) => setHidden(new Set(v.length ? EVENT_ORDER.filter((t) => !v.includes(t)) : []))}
                  testId="cal-f-events"
                  menuWidth={240}
                  options={EVENT_ORDER.map((t) => ({ value: t, label: EVENT_META[t].label, icon: <EventSwatch t={t} /> }))}
                />
                <MoreFilters count={more}>
                  <Dropdown block size="sm" label="Вид" value={filters.mode} onChange={set("mode")} testId="cal-f-mode" options={opts(facets.mode, "mode", (v) => ({ label: MODE_LABEL_CAL[v] ?? v }))} />
                  <Dropdown block size="sm" label="Куди" value={filters.place} onChange={set("place")} testId="cal-f-place" options={opts(facets.place, "destination")} />
                  <Dropdown block size="sm" label="Статус" value={filters.status} onChange={set("status")} testId="cal-f-status" options={opts(facets.status, "statusLabel")} />
                </MoreFilters>
                {(filtered || hidden.size > 0) && (
                  <button
                    type="button"
                    className="btn"
                    style={{ ...toolBtn, height: 30 }}
                    onClick={() => {
                      resetAll();
                      setHidden(new Set());
                    }}
                  >
                    Скинути
                  </button>
                )}
              </>
            );
          })()}
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

/** «Ще ▾»: the filters used less often, in a small panel under the bar. */
function MoreFilters({ count, children }: { count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // A list opened from inside the panel lives in a portal — it is still «inside».
      if (ref.current?.contains(t) || t.closest('[role="listbox"]')) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="listbox"]')) setOpen(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="ui-dd"
        aria-expanded={open}
        data-open={open || undefined}
        data-testid="cal-f-more"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 30,
          padding: "0 9px",
          borderRadius: 10,
          border: `1px solid ${count ? "color-mix(in srgb, var(--accent) 55%, var(--border))" : "var(--border)"}`,
          background: count ? "color-mix(in srgb, var(--accent) 9%, var(--surface))" : "var(--surface)",
          color: "var(--text)",
          font: "inherit",
          fontSize: 12.5,
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Ще{count ? ` · ${count}` : ""}
        <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden style={{ color: "var(--muted)", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div
          data-testid="cal-f-more-panel"
          style={{ position: "absolute", top: 36, left: 0, zIndex: 30, width: 260, display: "grid", gap: 6, padding: 8, background: "var(--menu)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "var(--shadow)", animation: "ui-pop .12s ease-out" }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** The event's mark as it looks on the calendar: its colour and border shape. */
function EventSwatch({ t }: { t: CalEventType }) {
  return (
    <span
      aria-hidden
      style={{
        width: 14,
        height: 10,
        borderRadius: 3,
        display: "inline-block",
        border: `2px ${EVENT_SHAPE[t].border} ${EVENT_META[t].color}`,
        background: `color-mix(in srgb, ${EVENT_META[t].color} 25%, transparent)`,
      }}
    />
  );
}
const iconBtn: React.CSSProperties = { width: 32, height: 32, padding: 0, fontSize: 16, display: "inline-flex", alignItems: "center", justifyContent: "center" };

