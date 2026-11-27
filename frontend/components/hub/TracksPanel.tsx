"use client";

// Left panel of the logistics hub: add a tracking number (live carrier
// detection as you type), numbers found in the shipment's documents, and the
// list of everything being tracked with status / progress / ETA / freshness.

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  ago,
  countdown,
  effEta,
  delayDays,
  etaShiftDays,
  lacksCoords,
  fmtDate,
  hubApi,
  KIND_LABEL,
  MODE_LABEL,
  statusColor,
  type CarrierRef,
  type DetectCandidate,
  type HubMode,
  type Track,
  type TrackingSuggestion,
} from "@/lib/hub";
import { CARGO_META, forwarderColor, type CargoType } from "@/lib/calendar";
import { Select } from "@/components/ui/Select";
import { Dropdown, type DropdownOption } from "@/components/ui/Dropdown";

export interface WorkspaceRef {
  id: string;
  number: string;
  supplier: string;
}

export type TrackListFilter = "all" | HubMode | "problems" | "nogeo" | "moving" | "port" | "done";
type Filter = TrackListFilter;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Всі" },
  { key: "moving", label: "В дорозі" },
  { key: "port", label: "У порту / митниці" },
  { key: "done", label: "Доставлено" },
  { key: "problems", label: "Увага" },
  { key: "sea", label: "Море" },
  { key: "air", label: "Авіа" },
  { key: "courier", label: "Курʼєр" },
  { key: "domestic", label: "Україна" },
  { key: "nogeo", label: "Без координат" },
];

const FILTER_ICON: Record<Filter, string> = { all: "▦", moving: "➜", port: "⚓", done: "✓", sea: "🚢", air: "✈️", courier: "📮", domestic: "🚚", problems: "⚠️", nogeo: "📍" };

/** Status groups — the same split as the map's bottom bar. */
const isMoving = (t: Track) => t.status === "in_transit" || t.status === "out_for_delivery";
const isAtPort = (t: Track) => t.status === "at_port" || t.status === "customs";

type Sort = "server" | "eta" | "late" | "updated" | "name";
const SORTS: { value: Sort; label: string; hint: string }[] = [
  { value: "server", label: "Спочатку важливі", hint: "Як є: проблемні й активні вгорі" },
  { value: "eta", label: "Найближче прибуття", hint: "Групи: прострочено · 3 дні · тиждень · пізніше" },
  { value: "late", label: "Найбільше запізнення", hint: "Проти плану з таблиці або зсуву ETA" },
  { value: "updated", label: "Нещодавно оновлені", hint: "Останні зміни від перевізника чи вручну" },
  { value: "name", label: "За назвою", hint: "А → Я" },
];

const DAY = 86_400_000;
/** ETA bucket of a track, for the «Найближче прибуття» headers. */
function etaBucket(t: Track, now: number): string {
  if (t.status === "delivered") return "Доставлено";
  const eta = effEta(t);
  if (!eta) return "Без ETA";
  const d = (Date.parse(eta) - now) / DAY;
  if (d < 0) return "Прострочено";
  if (d <= 3) return "Найближчі 3 дні";
  if (d <= 7) return "Цього тижня";
  return "Пізніше";
}

function sortTracks(list: Track[], sort: Sort, now: number): Track[] {
  if (sort === "server") return list;
  const out = [...list];
  const etaMs = (t: Track) => {
    if (t.status === "delivered") return Number.POSITIVE_INFINITY;
    const e = effEta(t);
    return e ? Date.parse(e) : Number.MAX_SAFE_INTEGER;
  };
  const late = (t: Track) => Math.max(delayDays(t) ?? 0, etaShiftDays(t));
  const changed = (t: Track) => Date.parse(t.lastChangedAt ?? t.lastCheckedAt ?? "") || 0;
  if (sort === "eta") out.sort((a, b) => etaMs(a) - etaMs(b));
  else if (sort === "late") out.sort((a, b) => late(b) - late(a) || etaMs(a) - etaMs(b));
  else if (sort === "updated") out.sort((a, b) => changed(b) - changed(a));
  else out.sort((a, b) => (a.label || a.number).localeCompare(b.label || b.number, "uk"));
  void now;
  return out;
}

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode */
  }
}

/** Needs attention: a problem, no data, a slipped ETA, or a hand-kept sea item still empty. */
const needsAttention = (t: Track) =>
  t.status === "exception" ||
  t.status === "unknown" ||
  etaShiftDays(t) >= 2 ||
  (delayDays(t) ?? 0) >= 2 ||
  (t.manualOnly && t.source !== "manual" && t.source !== "sheet");

const MODE_ICON: Record<HubMode, string> = { sea: "🚢", air: "✈️", courier: "📦", domestic: "🚚" };

export function TracksPanel({
  items,
  trackFilter,
  onTrackFilter,
  facets,
  selectedId,
  onSelect,
  onChanged,
  workspaceId,
  workspaces,
  filter: filterProp,
  onFilter,
}: {
  items: Track[];
  /** The list filter; lifted so the map's bottom bar can set it. */
  filter?: TrackListFilter;
  onFilter?: (f: TrackListFilter) => void;
  /** Who carries it / cargo type — shared with the map (same as the calendar). */
  trackFilter?: { forwarder: string; type: string };
  onTrackFilter?: (f: { forwarder: string; type: string }) => void;
  facets?: { forwarders: string[]; types: string[] };
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: (selectId?: string) => void;
  workspaceId?: string;
  workspaces: WorkspaceRef[];
}) {
  const [number, setNumber] = useState("");
  const [label, setLabel] = useState("");
  const [carrier, setCarrier] = useState("");
  const [linkWs, setLinkWs] = useState<string>(workspaceId ?? "");
  const [cands, setCands] = useState<DetectCandidate[] | null>(null);
  const [carriers, setCarriers] = useState<CarrierRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [ownFilter, setOwnFilter] = useState<Filter>("all");
  const filter = filterProp ?? ownFilter;
  const setFilter = (f: Filter) => (onFilter ? onFilter(f) : setOwnFilter(f));
  const [sort, setSortState] = useState<Sort>("server");
  const [dense, setDenseState] = useState(false);
  useEffect(() => {
    setSortState(readPref("hub-track-sort", SORTS.map((x) => x.value), "server"));
    setDenseState(readPref("hub-track-dense", ["1", "0"] as const, "0") === "1");
  }, []);
  const setSort = (v: Sort) => {
    setSortState(v);
    writePref("hub-track-sort", v);
  };
  const setDense = (v: boolean) => {
    setDenseState(v);
    writePref("hub-track-dense", v ? "1" : "0");
  };
  const [sugg, setSugg] = useState<TrackingSuggestion[]>([]);
  const [suggBusy, setSuggBusy] = useState<string | null>(null);
  // Numbers found in the shipment's documents — a collapsed dropdown so it doesn't push the list down.
  const [suggOpen, setSuggOpen] = useState(false);
  const detectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setLinkWs(workspaceId ?? ""), [workspaceId]);

  useEffect(() => {
    hubApi
      .carriers()
      .then((r) => setCarriers(r.carriers))
      .catch(() => {});
  }, []);

  // Numbers found in this shipment's documents (not yet tracked).
  useEffect(() => {
    if (!workspaceId) return setSugg([]);
    let cancelled = false;
    hubApi
      .suggestions(workspaceId)
      .then((r) => !cancelled && setSugg(r.suggestions ?? []))
      .catch(() => !cancelled && setSugg([]));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, items.length]);

  // Live carrier detection as the user types.
  useEffect(() => {
    if (detectTimer.current) clearTimeout(detectTimer.current);
    const n = number.trim();
    if (n.length < 6) {
      setCands(null);
      return;
    }
    detectTimer.current = setTimeout(() => {
      hubApi
        .detect(n)
        .then((r) => setCands(r.candidates))
        .catch(() => setCands(null));
    }, 280);
  }, [number]);

  const best = cands?.[0];
  const needsCarrier = cands !== null && (cands.length === 0 || (best?.confidence ?? 0) < 0.6);

  async function add(e?: React.FormEvent, override?: { number: string; carrier: string }) {
    e?.preventDefault();
    const n = override?.number ?? number.trim();
    if (!n) return;
    setBusy(true);
    setErr(null);
    if (override) setSuggBusy(override.number);
    try {
      const r = await hubApi.add({
        number: n,
        carrier: override?.carrier ?? (carrier || undefined),
        label: override ? undefined : label.trim() || undefined,
        workspaceId: linkWs || null,
      });
      if (!override) {
        setNumber("");
        setLabel("");
        setCarrier("");
        setCands(null);
      }
      onChanged(r.track.id);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Не вдалося додати номер.");
    } finally {
      setBusy(false);
      setSuggBusy(null);
    }
  }

  const passes = (t: Track, f: Filter) =>
    f === "all"
      ? true
      : f === "problems"
        ? needsAttention(t)
        : f === "nogeo"
          ? lacksCoords(t)
          : f === "moving"
            ? isMoving(t)
            : f === "port"
              ? isAtPort(t)
              : f === "done"
                ? t.status === "delivered"
                : t.mode === f;
  const visible = useMemo(() => sortTracks(items.filter((t) => passes(t, filter)), sort, Date.now()), [items, filter, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <form onSubmit={add} style={{ padding: 12, display: "grid", gap: 8, borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="Трек-номер: контейнер, B/L, AWB, ТТН…"
            aria-label="Трек-номер"
            style={inputStyle}
            data-testid="hub-number-input"
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !number.trim()} style={{ height: 36, padding: "0 12px" }}>
            {busy ? "…" : "Відстежувати"}
          </button>
        </div>

        {cands && (
          <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }} data-testid="hub-detect">
            {best ? (
              <>
                <span style={chip(best.confidence >= 0.8 ? "var(--ok)" : "var(--warn)")}>
                  {MODE_ICON[best.mode]} {best.carrierName} · {KIND_LABEL[best.kind]}
                  {best.confidence >= 0.95 ? " ✓" : ""}
                </span>
                {cands.length > 1 && <span>або: {cands.slice(1, 3).map((c) => c.carrierName).join(", ")}</span>}
              </>
            ) : (
              <span style={chip("var(--warn)")}>Перевізника не визначено — оберіть вручну</span>
            )}
          </div>
        )}

        {(needsCarrier || more) && (
          <Select value={carrier} onChange={(e) => setCarrier(e.target.value)} style={inputStyle} aria-label="Перевізник">
            <option value="">{best ? `Авто: ${best.carrierName}` : "Оберіть перевізника…"}</option>
            {(["sea", "air", "courier", "domestic"] as HubMode[]).map((m) => (
              <optgroup key={m} label={MODE_LABEL[m]}>
                {carriers
                  .filter((c) => c.mode === m)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
        )}

        {more && (
          <>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Назва (необовʼязково)" style={inputStyle} aria-label="Назва" />
            <Select value={linkWs} onChange={(e) => setLinkWs(e.target.value)} style={inputStyle} aria-label="Постачання">
              <option value="">Без привʼязки до постачання</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  №{w.number}
                  {w.supplier ? ` · ${w.supplier}` : ""}
                </option>
              ))}
            </Select>
          </>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button type="button" onClick={() => setMore((v) => !v)} style={linkBtn}>
            {more ? "Менше параметрів" : "Назва, перевізник, постачання…"}
          </button>
          {linkWs && !more && (
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
              → №{workspaces.find((w) => w.id === linkWs)?.number ?? "постачання"}
            </span>
          )}
        </div>
        {err && (
          <div role="alert" style={{ fontSize: 12.5, color: "var(--err)" }}>
            {err}
          </div>
        )}
      </form>

      {sugg.length > 0 && (
        <div style={{ margin: "10px 12px 0", borderRadius: 10, background: "var(--active)", fontSize: 12.5 }} data-testid="hub-suggestions">
          <button
            type="button"
            aria-expanded={suggOpen}
            onClick={() => setSuggOpen((o) => !o)}
            data-testid="hub-suggestions-toggle"
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 10px",
              border: "none",
              background: "none",
              color: "var(--text)",
              font: "inherit",
              fontSize: 12.5,
              fontWeight: 650,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>🧭 Штурман знайшов у документах постачання</span>
            <span style={{ flex: "none", minWidth: 20, height: 20, padding: "0 6px", borderRadius: 10, background: "var(--accent)", color: "var(--accentTx)", fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              {sugg.length}
            </span>
            <span aria-hidden style={{ flex: "none", transition: "transform .15s", transform: suggOpen ? "rotate(180deg)" : "none" }}>
              ▾
            </span>
          </button>
          {suggOpen && (
            <div style={{ display: "grid", gap: 6, padding: "0 10px 10px", maxHeight: 220, overflowY: "auto" }}>
              {sugg.map((s) => (
                <div key={s.number} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{s.number}</div>
                    <div style={{ color: "var(--muted)", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.files.join(", ")}>
                      {s.carrierName} · {s.files[0]}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Відстежувати ${s.number}`}
                    style={{ height: 28, padding: "0 10px", fontSize: 12, flex: "none" }}
                    disabled={suggBusy === s.number}
                    onClick={() => void add(undefined, { number: s.number, carrier: s.carrier })}
                  >
                    {suggBusy === s.number ? "…" : "+ Додати"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(() => {
        const countOf = (k: Filter) => items.filter((t) => passes(t, k)).length;
        const modeOptions: DropdownOption<Filter>[] = FILTERS.filter((f) => f.key === "all" || f.key === filter || countOf(f.key) > 0).map((f) => ({
          value: f.key,
          label: f.label,
          count: countOf(f.key),
          icon: FILTER_ICON[f.key],
          group: f.key === "all" ? undefined : ["moving", "port", "done", "problems"].includes(f.key) ? "Стан" : f.key === "nogeo" ? "Інше" : "Вид перевезення",
        }));
        const showFacets = !!(trackFilter && onTrackFilter && facets && (facets.forwarders.length > 0 || facets.types.length > 0));
        return (
          <div style={{ display: "flex", gap: 6, padding: "10px 12px 6px", flexWrap: "wrap" }} data-testid="hub-track-filters">
            <Dropdown size="sm" label="Показати" value={filter} onChange={setFilter} options={modeOptions} testId="hub-track-mode" />
            <Dropdown size="sm" compact label="Сортування" value={sort} onChange={setSort} testId="hub-track-sort" menuWidth={270} activeTint={false} options={SORTS} />
            <button
              type="button"
              className="ui-dd"
              onClick={() => setDense(!dense)}
              aria-pressed={dense}
              title={dense ? "Показати картками" : "Показати рядками — більше вантажів на екрані"}
              data-testid="hub-track-dense"
              style={{ height: 30, width: 30, borderRadius: 10, border: "1px solid var(--border)", background: dense ? "color-mix(in srgb, var(--accent) 10%, var(--surface))" : "var(--surface)", color: dense ? "var(--accent)" : "var(--muted)", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 14 }}
            >
              {dense ? "▤" : "☰"}
            </button>
            {showFacets && facets!.forwarders.length > 0 ? (
              <Dropdown
                size="sm"
                label="Хто везе"
                value={trackFilter!.forwarder}
                onChange={(v) => onTrackFilter!({ ...trackFilter!, forwarder: v })}
                testId="hub-track-forwarder"
                options={[{ value: "", label: "усі" }, ...facets!.forwarders.map((f) => ({ value: f, label: f, color: forwarderColor(f) }))]}
              />
            ) : null}
            {showFacets && facets!.types.length > 0 ? (
              <Dropdown
                size="sm"
                label="Тип"
                value={trackFilter!.type}
                onChange={(v) => onTrackFilter!({ ...trackFilter!, type: v })}
                testId="hub-track-type"
                options={[{ value: "", label: "усі" }, ...facets!.types.map((t) => ({ value: t, label: CARGO_META[t as CargoType]?.label ?? t, icon: CARGO_META[t as CargoType]?.icon }))]}
              />
            ) : null}
          </div>
        );
      })()}
      {filter === "nogeo" && visible.length > 0 && (
        <p style={{ margin: "0 12px 6px", fontSize: 12, color: "var(--muted)", lineHeight: 1.45 }}>
          Ці вантажі не вдалося покласти на карту: місце не розпізнано. Уточніть місто або порт у таблиці / картці.
        </p>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 8px 12px" }} data-testid="hub-track-list">
        {items.length === 0 ? (
          <EmptyState />
        ) : visible.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--muted)", padding: 12 }}>Немає вантажів у цьому фільтрі.</p>
        ) : (
          (() => {
            const now = Date.now();
            let last = "";
            return visible.map((t) => {
              const b = sort === "eta" ? etaBucket(t, now) : "";
              const head = b && b !== last ? ((last = b), b) : null;
              const row = dense ? (
                <TrackLine key={t.id} t={t} selected={t.id === selectedId} onClick={() => onSelect(t.id)} />
              ) : (
                <TrackRow key={t.id} t={t} selected={t.id === selectedId} onClick={() => onSelect(t.id)} />
              );
              return head ? (
                <div key={`h-${t.id}`}>
                  <div data-testid="hub-track-group" style={{ position: "sticky", top: -4, zIndex: 1, padding: "8px 4px 5px", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: head === "Прострочено" ? "var(--err)" : "var(--faint)", background: "var(--panel, var(--bg))" }}>
                    {head} · {visible.filter((x) => etaBucket(x, now) === head).length}
                  </div>
                  {row}
                </div>
              ) : (
                row
              );
            });
          })()
        )}
      </div>
    </div>
  );
}


/** One line per item: the dense list for a logist scanning many shipments. */
function TrackLine({ t, selected, onClick }: { t: Track; selected: boolean; onClick: () => void }) {
  const color = statusColor(t.status);
  const eta = effEta(t);
  const left = eta && t.status !== "delivered" ? countdown(eta) : null;
  const delay = delayDays(t);
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="hub-track-row"
      title={`${t.label || t.number} · ${t.carrierName} · ${t.origin || "—"} → ${t.destination || "—"}`}
      style={{
        width: "100%",
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "6px 8px",
        marginBottom: 2,
        borderRadius: 8,
        border: `1px solid ${selected ? color : "transparent"}`,
        borderLeft: `3px solid ${t.forwarder ? forwarderColor(t.forwarder) : color}`,
        background: selected ? "color-mix(in srgb, var(--surface) 88%, var(--accent) 12%)" : "var(--surface)",
        color: "var(--text)",
        cursor: "pointer",
        font: "inherit",
        fontSize: 12.5,
      }}
    >
      <span aria-hidden style={{ flex: "none" }}>{MODE_ICON[t.mode]}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <b style={{ fontWeight: 650 }}>{t.label || t.number}</b>
        <span style={{ color: "var(--muted)" }}> · {t.destination || t.carrierName}</span>
      </span>
      {left ? (
        <span style={{ flex: "none", fontSize: 11.5, color: left.late || (delay ?? 0) >= 2 ? "var(--err)" : "var(--muted)", fontVariantNumeric: "tabular-nums" }} data-testid="hub-row-eta">
          {left.late ? `−${left.text}` : left.text}
        </span>
      ) : null}
      <span aria-label={t.statusLabel} title={t.statusLabel} style={{ width: 8, height: 8, borderRadius: 99, background: color, flex: "none" }} />
    </button>
  );
}

function TrackRow({ t, selected, onClick }: { t: Track; selected: boolean; onClick: () => void }) {
  const color = statusColor(t.status);
  const delay = delayDays(t);
  const noGeo = lacksCoords(t);
  const progress = t.status === "delivered" ? 1 : (t.live?.progress ?? 0);
  const shift = etaShiftDays(t);
  const eta = effEta(t);
  const left = eta && t.status !== "delivered" ? countdown(eta) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="hub-track-row"
      style={{
        width: "100%",
        textAlign: "left",
        display: "grid",
        gap: 6,
        padding: "10px 10px",
        marginBottom: 6,
        borderRadius: 11,
        border: `1px solid ${selected ? color : "var(--border)"}`,
        background: selected ? "color-mix(in srgb, var(--surface) 88%, var(--accent) 12%)" : "var(--surface)",
        color: "var(--text)",
        cursor: "pointer",
        font: "inherit",
        boxShadow: selected ? "0 4px 16px rgba(0,0,0,.08)" : "none",
        transition: "border-color .15s, background .15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 16, flex: "none" }} aria-hidden>
          {MODE_ICON[t.mode]}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 650, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t.label || t.number}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t.cargoType && CARGO_META[t.cargoType as CargoType] ? `${CARGO_META[t.cargoType as CargoType].icon} ` : ""}
            {t.label ? `${t.number} · ` : ""}
            {t.carrierName}
            {t.workspaceNumber ? ` · №${t.workspaceNumber}` : ""}
          </div>
          {t.forwarder && (
            <div style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 5, color: "var(--muted)" }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: forwarderColor(t.forwarder), flex: "none" }} />
              {t.forwarder}
            </div>
          )}
        </div>
        <span style={pill(color)}>{t.statusLabel}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {t.origin || "—"} → {t.destination || "—"}
        </span>
        {eta && left && (
          <span
            style={{ flex: "none", color: shift >= 2 || left.late ? "var(--err)" : "var(--muted)" }}
            title={t.eta ? `ETA ${fmtDate(t.eta)}` : "Орієнтовно — розраховано за відстанню маршруту"}
            data-testid="hub-row-eta"
          >
            {t.eta ? "" : "≈ "}
            {left.late ? `прострочено ${left.text}` : `${left.text} до прибуття`}
            {shift !== 0 ? ` (${shift > 0 ? "+" : ""}${shift} дн)` : ""}
          </span>
        )}
      </div>
      {delay != null && delay >= 1 && (
        <div style={{ fontSize: 12, color: "var(--err)", fontWeight: 600 }} data-testid="hub-row-delay">
          ⚠ запізнюється на {delay} дн проти плану ({fmtDate(`${t.planArrival}T00:00:00Z`).slice(0, 5)})
        </div>
      )}
      {noGeo && (
        <div style={{ fontSize: 11.5, color: "var(--warn)" }}>📍 Немає координат — місце не розпізнано</div>
      )}
      <div style={{ height: 4, borderRadius: 4, background: "var(--hover)", overflow: "hidden" }} aria-hidden>
        <div style={{ width: `${Math.round(progress * 100)}%`, height: "100%", background: color, borderRadius: 4, transition: "width .6s" }} />
      </div>
      <div style={{ fontSize: 11, color: "var(--faint)" }}>
        {t.sheet
          ? `З таблиці · рядок ${t.sheet.rowIndex} · ${ago(t.lastChangedAt ?? t.lastCheckedAt)}`
          : t.manualOnly
          ? t.source !== "manual"
            ? "Ведеться вручну — внесіть дані"
            : `Внесено вручну ${ago(t.lastChangedAt)}`
          : t.source === "none"
            ? "Немає даних від перевізника"
            : `Оновлено ${ago(t.lastCheckedAt)}`}
      </div>
    </button>
  );
}

function EmptyState() {
  return (
    <div style={{ padding: "18px 10px", textAlign: "center", color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
      <div style={{ fontSize: 34, marginBottom: 6 }} aria-hidden>
        🧭
      </div>
      <div style={{ fontWeight: 650, color: "var(--text)", marginBottom: 4 }}>Хаб порожній</div>
      Вставте номер контейнера, коносамента, AWB, курʼєрської накладної або ТТН Нової Пошти — Штурман визначить перевізника, покаже вантаж на
      карті й стежитиме за статусом.
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 36,
  padding: "0 11px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 13,
};

const linkBtn: React.CSSProperties = {
  background: "none",
  border: 0,
  padding: 0,
  color: "var(--accent)",
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
};

function chip(color: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 8px",
    borderRadius: 999,
    fontWeight: 600,
    color: "var(--text)",
    background: `color-mix(in srgb, ${color} 16%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
  };
}

export function pill(color: string): React.CSSProperties {
  return {
    flex: "none",
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 650,
    whiteSpace: "nowrap",
    color,
    background: `color-mix(in srgb, ${color} 13%, transparent)`,
  };
}

