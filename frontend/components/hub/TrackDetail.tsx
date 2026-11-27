"use client";

// Right-hand detail card of a tracked item: status, route + progress, ETA (and
// how far it slipped), where the position on the map comes from, the carrier
// event timeline, and actions (refresh, carrier page, link to a shipment,
// archive, delete). Always shows the data source and its freshness. Sea lines
// are kept by hand (track.manualOnly): the logist enters status / ETA / vessel /
// milestones via ManualTrackForm instead of refreshing from the carrier.

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  ago,
  countdown,
  delayDays,
  effDeparted,
  effEta,
  etaShiftDays,
  fmtDate,
  hubApi,
  KIND_LABEL,
  POSITION_LABEL,
  sourceLabel,
  statusColor,
  type Track,
  type TrackEvent,
} from "@/lib/hub";
import { ManualEventForm, ManualTrackForm } from "./ManualTrackForm";
import { pill, type WorkspaceRef } from "./TracksPanel";
import { Dropdown } from "@/components/ui/Dropdown";

export function TrackDetail({
  track,
  workspaces,
  onClose,
  onChanged,
  onRemoved,
  onPlay,
}: {
  track: Track;
  workspaces: WorkspaceRef[];
  onClose: () => void;
  onChanged: () => void;
  onRemoved: () => void;
  onPlay?: (events: TrackEvent[]) => void;
}) {
  const [events, setEvents] = useState<TrackEvent[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    hubApi
      .get(track.id)
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]));
  }, [track.id]);

  useEffect(() => {
    setEvents(null);
    setMsg(null);
    load();
  }, [load, track.lastCheckedAt]);

  const [confirmDel, setConfirmDel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setEditing(false);
    setMenuOpen(false);
  }, [track.id]);

  // Shipments whose documents mention this number — offered for linking (logist confirms).
  const [matches, setMatches] = useState<Array<{ id: string; number: string; supplier: string }>>([]);
  useEffect(() => {
    setMatches([]);
    if (track.workspaceId) return;
    let off = false;
    hubApi
      .workspaceMatches(track.id)
      .then((r) => !off && setMatches(r.matches))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [track.id, track.workspaceId]);

  async function act(kind: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
      onChanged();
      load();
      return true;
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Не вдалося виконати дію.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  const removeEvent = (e: TrackEvent) => void act(`ev:${e.id}`, () => hubApi.removeEvent(track.id, e.id));

  // Countdown ticks on its own; dates the logist changes flow in via `track`.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const eta = effEta(track);
  const departed = effDeparted(track);
  const left = eta && track.status !== "delivered" ? countdown(eta, now) : null;

  const color = statusColor(track.status);
  const shift = etaShiftDays(track);
  const progress = track.status === "delivered" ? 1 : (track.live?.progress ?? 0);
  const past = (events ?? []).filter((e) => !e.planned).reverse();
  const planned = (events ?? []).filter((e) => e.planned);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }} data-testid="hub-track-detail">
      {/* Header: what it is, its state, what to do */}
      <div
        style={{
          position: "relative",
          padding: "16px 14px 12px",
          borderBottom: "1px solid var(--border)",
          background: `linear-gradient(180deg, color-mix(in srgb, ${color} 9%, transparent), transparent 70%)`,
        }}
      >
        <div aria-hidden style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: color }} />
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span
            aria-hidden
            style={{ width: 38, height: 38, flex: "none", borderRadius: 11, display: "grid", placeItems: "center", fontSize: 19, background: `color-mix(in srgb, ${color} 14%, var(--surface))`, border: `1px solid color-mix(in srgb, ${color} 30%, transparent)` }}
          >
            {DETAIL_MODE_ICON[track.mode] ?? "📦"}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 650 }}>
              {track.carrierName} · {KIND_LABEL[track.kind]}
            </div>
            <div style={{ fontSize: 17, fontWeight: 750, lineHeight: 1.25, overflowWrap: "anywhere" }}>{track.label || track.number}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <span style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{track.number}</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(track.number).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
                title="Скопіювати номер"
                aria-label="Скопіювати номер"
                data-testid="hub-copy-number"
                style={{ border: "none", background: "none", padding: "0 2px", cursor: "pointer", color: copied ? "var(--ok)" : "var(--muted)", fontSize: 12.5 }}
              >
                {copied ? "✓ скопійовано" : "⧉"}
              </button>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Закрити" style={closeBtn}>
            ×
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <span style={{ ...pill(color), fontSize: 12, padding: "3px 10px" }}>{track.statusLabel}</span>
          {track.statusText && track.statusText !== track.statusLabel && <span style={{ fontSize: 12.5, color: "var(--muted)" }}>«{track.statusText}»</span>}
        </div>

        {/* Actions: the everyday ones in reach, archive / delete behind «⋯» */}
        <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
          {track.manualOnly && track.sheet ? (
            <a className="btn btn-primary" style={{ ...actionBtn, flex: 1, textDecoration: "none" }} href={track.sheet.url ?? undefined} target="_blank" rel="noreferrer noopener" title="Дані цього вантажу — у робочій таблиці">
              Таблиця ↗
            </a>
          ) : track.manualOnly ? (
            <button type="button" className="btn btn-primary" style={{ ...actionBtn, flex: 1 }} disabled={busy !== null || editing} onClick={() => setEditing(true)} data-testid="hub-manual-edit">
              ✎ Внести дані
            </button>
          ) : (
            <button type="button" className="btn btn-primary" style={{ ...actionBtn, flex: 1 }} disabled={busy !== null} onClick={() => void act("refresh", () => hubApi.refresh(track.id))}>
              {busy === "refresh" ? "Перевіряю…" : "↻ Оновити"}
            </button>
          )}
          {track.trackUrl && (
            <a className="btn" style={{ ...actionBtn, flex: 1, textDecoration: "none" }} href={track.trackUrl} target="_blank" rel="noreferrer noopener" title="Сайт перевізника">
              Сайт ↗
            </a>
          )}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="btn"
              aria-label="Ще дії"
              aria-expanded={menuOpen}
              data-testid="hub-track-more"
              onClick={() => {
                setMenuOpen((v) => !v);
                setConfirmDel(false);
              }}
              style={{ ...actionBtn, width: 38 }}
            >
              ⋯
            </button>
            {menuOpen && (
              <div
                role="menu"
                style={{ position: "absolute", right: 0, top: 40, zIndex: 20, width: 200, padding: 6, display: "grid", gap: 2, background: "var(--menu)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow)" }}
              >
                <button
                  type="button"
                  role="menuitem"
                  style={menuItem}
                  disabled={busy !== null}
                  onClick={() => {
                    setMenuOpen(false);
                    void act("archive", () => hubApi.patch(track.id, { archived: true })).then((ok) => ok && onRemoved());
                  }}
                >
                  🗄 В архів
                </button>
                <button
                  type="button"
                  role="menuitem"
                  style={{ ...menuItem, color: "var(--err)", fontWeight: confirmDel ? 700 : 500 }}
                  disabled={busy !== null}
                  onClick={() => {
                    if (!confirmDel) return setConfirmDel(true);
                    setMenuOpen(false);
                    void act("delete", () => hubApi.remove(track.id)).then((ok) => ok && onRemoved());
                  }}
                >
                  {confirmDel ? "Точно видалити?" : "🗑 Видалити"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, display: "grid", gap: 10, alignContent: "start" }}>
        {/* Arrival: the one thing a logist looks for first */}
        <section style={card}>
          {left ? (
            <div data-testid="hub-countdown" style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <b style={{ fontSize: 18, color: left.late ? "var(--err)" : "var(--text)" }}>{left.late ? `Прострочено на ${left.text}` : `До прибуття: ${left.text}`}</b>
              {track.live?.etaEstimated && <span style={{ fontSize: 11.5, color: "var(--muted)" }}>орієнтовно — розраховано за відстанню маршруту</span>}
            </div>
          ) : track.status === "delivered" ? (
            <b style={{ fontSize: 16, color: "var(--ok)" }}>✓ Доставлено {fmtDate(track.arrivedAt)}</b>
          ) : (
            <b style={{ fontSize: 14, color: "var(--muted)" }}>Дата прибуття невідома</b>
          )}
          {(() => {
            const d = delayDays(track);
            return d != null && track.planArrival && d !== 0 ? (
              <div data-testid="hub-plan-delay" style={{ marginTop: 6, fontSize: 12.5, color: d > 0 ? "var(--err)" : "var(--ok)", fontWeight: 650 }}>
                {d > 0 ? "⚠ Запізнюється" : "Випереджає"} на {Math.abs(d)} дн проти плану таблиці ({fmtDate(`${track.planArrival}T00:00:00Z`)})
              </div>
            ) : null;
          })()}
          {shift !== 0 && track.status !== "delivered" && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: shift > 0 ? "var(--err)" : "var(--ok)" }}>
              ETA зсунулась на {shift > 0 ? "+" : ""}
              {shift} дн. (спершу було {fmtDate(track.firstEta)})
            </div>
          )}

          {/* Route: from — progress — to */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto minmax(0,1fr)", alignItems: "center", gap: 8, marginTop: 12, fontSize: 13 }}>
            <div style={{ minWidth: 0 }}>
              <div style={label}>Звідки</div>
              <div style={{ fontWeight: 650, overflowWrap: "anywhere" }}>{track.origin || "—"}</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                {!track.departedAt && departed ? "≈ " : ""}
                {fmtDate(departed)}
              </div>
            </div>
            <span style={{ fontSize: 11.5, fontWeight: 750, color, fontVariantNumeric: "tabular-nums" }}>{Math.round(progress * 100)}%</span>
            <div style={{ minWidth: 0, textAlign: "right" }}>
              <div style={label}>Куди</div>
              <div style={{ fontWeight: 650, overflowWrap: "anywhere" }}>{track.destination || "—"}</div>
              <div style={{ fontSize: 11.5, color: shift >= 2 ? "var(--err)" : "var(--muted)" }}>
                {track.status === "delivered" ? `Доставлено ${fmtDate(track.arrivedAt)}` : `ETA ${!track.eta && eta ? "≈ " : ""}${fmtDate(eta)}`}
              </div>
            </div>
          </div>
          <div style={{ position: "relative", height: 8, borderRadius: 6, background: "var(--hover)", marginTop: 8 }}>
            <div style={{ position: "absolute", inset: 0, width: `${Math.round(progress * 100)}%`, background: color, borderRadius: 6, transition: "width .6s" }} />
            <span aria-hidden style={{ position: "absolute", top: -3, left: `calc(${Math.round(progress * 100)}% - 7px)`, width: 14, height: 14, borderRadius: 99, background: "var(--surface)", border: `3px solid ${color}`, transition: "left .6s" }} />
          </div>

          {(track.vesselName || track.live?.positionSource) && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border)" }}>
              {track.vesselName && (
                <div style={{ fontSize: 13 }}>
                  🚢 <b>{track.vesselName}</b>
                  {track.vesselImo ? <span style={{ color: "var(--muted)" }}> · IMO {track.vesselImo}</span> : null}
                  {track.live?.vessel?.sog != null && <span style={{ color: "var(--muted)" }}> · {track.live.vessel.sog.toFixed(1)} вуз.</span>}
                </div>
              )}
              {track.live?.positionSource && (
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: track.vesselName ? 4 : 0 }}>
                  📍 {POSITION_LABEL[track.live.positionSource]}
                  {track.live.vessel ? ` (${ago(track.live.vessel.updatedAt)})` : ""}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Source + freshness */}
        <section style={{ fontSize: 12, color: "var(--muted)", display: "grid", gap: 3, padding: "0 2px" }}>
          <div>
            Джерело: <b style={{ color: "var(--text)" }}>{sourceLabel(track.source)}</b> · перевірено {ago(track.lastCheckedAt)}
          </div>
          {track.lastError && !track.manualOnly && <div style={{ color: "var(--warn)" }}>⚠ {track.lastError}</div>}
          {track.source === "none" && !track.manualOnly && <div>Даних від перевізника поки немає — Штурман не вгадує статус. Перевірте на сайті перевізника.</div>}
        </section>

        {/* From the team sheet: the plan lives there */}
        {track.sheet && (
          <section style={{ ...box, fontSize: 12.5, display: "grid", gap: 6 }} data-testid="hub-sheet-source">
            <div>📋 З робочої таблиці (рядок {track.sheet.rowIndex}) — маршрут, дати й статус оновлюються щогодини; змінюйте їх у таблиці. Події можна додавати тут.</div>
            {track.sheet.url && (
              <a className="btn" href={track.sheet.url} target="_blank" rel="noreferrer noopener" style={{ height: 30, fontSize: 12.5, textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                Відкрити рядок у таблиці ↗
              </a>
            )}
          </section>
        )}

        {/* Manual data (sea lines are tracked by hand) */}
        {editing && !track.sheet ? (
          <ManualTrackForm
            track={track}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              onChanged();
              load();
            }}
          />
        ) : (
          track.manualOnly &&
          !track.sheet &&
          track.source !== "manual" && (
            <section style={{ ...box, fontSize: 12.5, display: "grid", gap: 8 }} data-testid="hub-manual-hint">
              <div>Морські перевезення ведуться вручну: внесіть статус, ETA і судно з коносамента — дані побачить уся команда, а судно зʼявиться на карті.</div>
              <button type="button" className="btn btn-primary" style={{ height: 32, fontSize: 12.5 }} onClick={() => setEditing(true)}>
                ✎ Внести дані
              </button>
            </section>
          )
        )}

        {/* Timeline */}
        <section style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={label}>Події{events && events.length ? ` · ${events.length}` : ""}</div>
            {onPlay && (
              <button
                type="button"
                className="btn"
                data-testid="hub-play"
                disabled={!events || events.length === 0 || (track.live?.path.length ?? 0) < 2}
                title={(track.live?.path.length ?? 0) < 2 ? "Немає маршруту для відтворення" : "Показати рух вантажу по днях проти плану"}
                onClick={() => events && onPlay(events)}
                style={{ height: 28, padding: "0 10px", fontSize: 12 }}
              >
                ▶ Програти рейс
              </button>
            )}
          </div>
          {events === null ? (
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Завантаження…</div>
          ) : past.length + planned.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Подій ще немає.</div>
          ) : (
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 0 }} data-testid="hub-timeline">
              {planned.map((e) => (
                <TimelineItem key={e.id} e={e} color="var(--faint)" dashed onRemove={removeEvent} />
              ))}
              {past.map((e, i) => (
                <TimelineItem key={e.id} e={e} color={i === 0 ? color : "var(--muted)"} first={i === 0} onRemove={removeEvent} />
              ))}
            </ol>
          )}
          {(track.manualOnly || editing) && (
            <ManualEventForm
              trackId={track.id}
              onSaved={() => {
                onChanged();
                load();
              }}
            />
          )}
        </section>

        {/* Link to shipment */}
        <section style={card}>
          <div style={{ ...label, marginBottom: 8 }}>Постачання</div>
          <Dropdown
            block
            value={track.workspaceId ?? ""}
            onChange={(v) => void act("link", () => hubApi.patch(track.id, { workspaceId: v || null }))}
            disabled={busy !== null}
            ariaLabel="Привʼязати до постачання"
            testId="hub-track-workspace"
            activeTint={false}
            options={[{ value: "", label: "Без привʼязки" }, ...workspaces.map((w) => ({ value: w.id, label: `№${w.number}`, hint: w.supplier || undefined }))]}
          />
          {!track.workspaceId && matches.length > 0 && (
            <div style={{ marginTop: 8, display: "grid", gap: 4 }} data-testid="hub-workspace-matches">
              {matches.map((w) => (
                <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                  <span style={{ flex: 1, minWidth: 0, color: "var(--muted)" }}>
                    Номер є в документах №{w.number}
                    {w.supplier ? ` · ${w.supplier}` : ""}
                  </span>
                  <button type="button" className="btn" style={{ height: 26, padding: "0 9px", fontSize: 12 }} disabled={busy !== null} onClick={() => void act("link", () => hubApi.patch(track.id, { workspaceId: w.id }))}>
                    Привʼязати
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {msg && (
          <div role="alert" style={{ fontSize: 12.5, color: "var(--err)" }}>
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineItem({
  e,
  color,
  first,
  dashed,
  onRemove,
}: {
  e: TrackEvent;
  color: string;
  first?: boolean;
  dashed?: boolean;
  onRemove?: (e: TrackEvent) => void;
}) {
  return (
    <li style={{ display: "grid", gridTemplateColumns: "16px 1fr", gap: 10 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <span
          style={{
            width: first ? 12 : 9,
            height: first ? 12 : 9,
            marginTop: 4,
            borderRadius: "50%",
            background: dashed ? "transparent" : color,
            border: dashed ? `2px dashed ${color}` : "none",
            boxShadow: first ? `0 0 0 4px color-mix(in srgb, ${color} 22%, transparent)` : "none",
            flex: "none",
          }}
        />
        <span style={{ flex: 1, width: 2, background: "var(--border)", minHeight: 14 }} />
      </div>
      <div style={{ paddingBottom: 12, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: first ? 650 : 500, color: dashed ? "var(--muted)" : "var(--text)" }}>
          {e.description}
          {dashed ? " (план)" : ""}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <span>
            {fmtDate(e.at, true)}
            {e.location ? ` · ${e.location}` : ""}
            {e.manual ? " · вручну" : ""}
          </span>
          {e.manual && onRemove && (
            <button
              type="button"
              onClick={() => onRemove(e)}
              aria-label="Видалити подію"
              title="Видалити подію"
              style={{ border: "none", background: "none", color: "var(--muted)", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1 }}
            >
              ×
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

const DETAIL_MODE_ICON: Record<string, string> = { sea: "🚢", air: "✈️", courier: "📦", domestic: "🚚" };

/** A raised block of the detail panel. */
const card: React.CSSProperties = {
  padding: 12,
  borderRadius: 12,
  border: "1px solid var(--border)",
  background: "var(--surface)",
};

const menuItem: React.CSSProperties = {
  textAlign: "left",
  border: "none",
  background: "transparent",
  borderRadius: 8,
  padding: "8px 10px",
  cursor: "pointer",
  color: "var(--text)",
  font: "inherit",
  fontSize: 13,
};

const label: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 650,
  color: "var(--muted)",
  textTransform: "uppercase",
  letterSpacing: ".05em",
};

const box: React.CSSProperties = {
  padding: 10,
  borderRadius: 10,
  background: "var(--hover)",
};

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

const actionBtn: React.CSSProperties = {
  height: 34,
  padding: "0 6px",
  fontSize: 12.5,
  width: "100%",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
