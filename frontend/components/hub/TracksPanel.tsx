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
  etaShiftDays,
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

export interface WorkspaceRef {
  id: string;
  number: string;
  supplier: string;
}

type Filter = "all" | HubMode | "problems";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Всі" },
  { key: "sea", label: "Море" },
  { key: "air", label: "Авіа" },
  { key: "courier", label: "Курʼєр" },
  { key: "domestic", label: "Україна" },
  { key: "problems", label: "Увага" },
];

/** Needs attention: a problem, no data, a slipped ETA, or a hand-kept sea item still empty. */
const needsAttention = (t: Track) =>
  t.status === "exception" || t.status === "unknown" || etaShiftDays(t) >= 2 || (t.manualOnly && t.source !== "manual" && t.source !== "sheet");

const MODE_ICON: Record<HubMode, string> = { sea: "🚢", air: "✈️", courier: "📦", domestic: "🚚" };

export function TracksPanel({
  items,
  selectedId,
  onSelect,
  onChanged,
  workspaceId,
  workspaces,
}: {
  items: Track[];
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
  const [filter, setFilter] = useState<Filter>("all");
  const [sugg, setSugg] = useState<TrackingSuggestion[]>([]);
  const [suggBusy, setSuggBusy] = useState<string | null>(null);
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

  const visible = useMemo(
    () =>
      items.filter((t) =>
        filter === "all"
          ? true
          : filter === "problems"
            ? needsAttention(t)
            : t.mode === filter
      ),
    [items, filter]
  );

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
          <select value={carrier} onChange={(e) => setCarrier(e.target.value)} style={inputStyle} aria-label="Перевізник">
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
          </select>
        )}

        {more && (
          <>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Назва (необовʼязково)" style={inputStyle} aria-label="Назва" />
            <select value={linkWs} onChange={(e) => setLinkWs(e.target.value)} style={inputStyle} aria-label="Постачання">
              <option value="">Без привʼязки до постачання</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  №{w.number}
                  {w.supplier ? ` · ${w.supplier}` : ""}
                </option>
              ))}
            </select>
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
        <div style={{ margin: "10px 12px 0", padding: 10, borderRadius: 10, background: "var(--active)", fontSize: 12.5 }} data-testid="hub-suggestions">
          <div style={{ fontWeight: 650, marginBottom: 6 }}>🧭 Штурман знайшов у документах постачання:</div>
          <div style={{ display: "grid", gap: 6 }}>
            {sugg.slice(0, 5).map((s) => (
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
        </div>
      )}

      <div style={{ display: "flex", gap: 4, padding: "10px 12px 6px", flexWrap: "wrap" }} role="tablist" aria-label="Фільтр">
        {FILTERS.map((f) => {
          const count =
            f.key === "all"
              ? items.length
              : f.key === "problems"
                ? items.filter(needsAttention).length
                : items.filter((t) => t.mode === f.key).length;
          if (f.key !== "all" && count === 0) return null;
          return (
            <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)} style={filterBtn(filter === f.key, f.key === "problems")}>
              {f.label} <span style={{ opacity: 0.6 }}>{count}</span>
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 8px 12px" }} data-testid="hub-track-list">
        {items.length === 0 ? (
          <EmptyState />
        ) : visible.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--muted)", padding: 12 }}>Немає вантажів у цьому фільтрі.</p>
        ) : (
          visible.map((t) => <TrackRow key={t.id} t={t} selected={t.id === selectedId} onClick={() => onSelect(t.id)} />)
        )}
      </div>
    </div>
  );
}

function TrackRow({ t, selected, onClick }: { t: Track; selected: boolean; onClick: () => void }) {
  const color = statusColor(t.status);
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
            {t.label ? `${t.number} · ` : ""}
            {t.carrierName}
            {t.workspaceNumber ? ` · №${t.workspaceNumber}` : ""}
          </div>
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

function filterBtn(active: boolean, warn: boolean): React.CSSProperties {
  return {
    height: 26,
    padding: "0 9px",
    borderRadius: 999,
    border: `1px solid ${active ? (warn ? "var(--err)" : "var(--accent)") : "var(--border)"}`,
    background: active ? (warn ? "color-mix(in srgb, var(--err) 12%, transparent)" : "var(--active)") : "transparent",
    color: "var(--text)",
    font: "inherit",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };
}
