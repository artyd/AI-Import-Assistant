"use client";

// Right-hand detail card of a tracked item: status, route + progress, ETA (and
// how far it slipped), where the position on the map comes from, the carrier
// event timeline, and actions (refresh, carrier page, link to a shipment,
// archive, delete). Always shows the data source and its freshness.

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  ago,
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
import { pill, type WorkspaceRef } from "./TracksPanel";

export function TrackDetail({
  track,
  workspaces,
  onClose,
  onChanged,
  onRemoved,
}: {
  track: Track;
  workspaces: WorkspaceRef[];
  onClose: () => void;
  onChanged: () => void;
  onRemoved: () => void;
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

  const color = statusColor(track.status);
  const shift = etaShiftDays(track);
  const progress = track.status === "delivered" ? 1 : (track.live?.progress ?? 0);
  const past = (events ?? []).filter((e) => !e.planned).reverse();
  const planned = (events ?? []).filter((e) => e.planned);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }} data-testid="hub-track-detail">
      <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>
              {track.carrierName} · {KIND_LABEL[track.kind]}
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, overflowWrap: "anywhere" }}>{track.label || track.number}</div>
            {track.label && <div style={{ fontSize: 12.5, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>{track.number}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Закрити" style={closeBtn}>
            ×
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <span style={{ ...pill(color), fontSize: 12, padding: "3px 10px" }}>{track.statusLabel}</span>
          {track.statusText && track.statusText !== track.statusLabel && (
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>«{track.statusText}»</span>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "grid", gap: 14, alignContent: "start" }}>
        {/* Route + progress */}
        <section>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
            <div style={{ minWidth: 0 }}>
              <div style={label}>Звідки</div>
              <div style={{ fontWeight: 600 }}>{track.origin || "—"}</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{fmtDate(track.departedAt)}</div>
            </div>
            <div style={{ minWidth: 0, textAlign: "right" }}>
              <div style={label}>Куди</div>
              <div style={{ fontWeight: 600 }}>{track.destination || "—"}</div>
              <div style={{ fontSize: 11.5, color: shift >= 2 ? "var(--err)" : "var(--muted)" }}>
                {track.status === "delivered" ? `Доставлено ${fmtDate(track.arrivedAt)}` : `ETA ${fmtDate(track.eta)}`}
              </div>
            </div>
          </div>
          <div style={{ position: "relative", height: 8, borderRadius: 6, background: "var(--hover)", marginTop: 10 }}>
            <div style={{ position: "absolute", inset: 0, width: `${Math.round(progress * 100)}%`, background: color, borderRadius: 6, transition: "width .6s" }} />
          </div>
          {shift !== 0 && track.status !== "delivered" && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: shift > 0 ? "var(--err)" : "var(--ok)" }}>
              ETA зсунулась на {shift > 0 ? "+" : ""}
              {shift} дн. (спершу було {fmtDate(track.firstEta)})
            </div>
          )}
        </section>

        {/* Vessel + position provenance */}
        {(track.vesselName || track.live?.positionSource) && (
          <section style={box}>
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
          </section>
        )}

        {/* Source + freshness */}
        <section style={{ fontSize: 12, color: "var(--muted)", display: "grid", gap: 3 }}>
          <div>
            Джерело: <b style={{ color: "var(--text)" }}>{sourceLabel(track.source)}</b> · перевірено {ago(track.lastCheckedAt)}
          </div>
          {track.lastError && <div style={{ color: "var(--warn)" }}>⚠ {track.lastError}</div>}
          {track.source === "none" && (
            <div>Даних від перевізника поки немає — Штурман не вгадує статус. Перевірте на сайті перевізника.</div>
          )}
        </section>

        {/* Timeline */}
        <section>
          <div style={{ ...label, marginBottom: 8 }}>Події</div>
          {events === null ? (
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Завантаження…</div>
          ) : past.length + planned.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Подій ще немає.</div>
          ) : (
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 0 }} data-testid="hub-timeline">
              {planned.map((e) => (
                <TimelineItem key={e.id} e={e} color="var(--faint)" dashed />
              ))}
              {past.map((e, i) => (
                <TimelineItem key={e.id} e={e} color={i === 0 ? color : "var(--muted)"} first={i === 0} />
              ))}
            </ol>
          )}
        </section>

        {/* Link to shipment */}
        <section>
          <div style={{ ...label, marginBottom: 6 }}>Постачання</div>
          <select
            value={track.workspaceId ?? ""}
            onChange={(e) => void act("link", () => hubApi.patch(track.id, { workspaceId: e.target.value || null }))}
            disabled={busy !== null}
            aria-label="Привʼязати до постачання"
            style={{ width: "100%", height: 34, borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", font: "inherit", fontSize: 13, padding: "0 8px" }}
          >
            <option value="">Без привʼязки</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                №{w.number}
                {w.supplier ? ` · ${w.supplier}` : ""}
              </option>
            ))}
          </select>
        </section>

        {msg && (
          <div role="alert" style={{ fontSize: 12.5, color: "var(--err)" }}>
            {msg}
          </div>
        )}
      </div>

      <div style={{ padding: 12, borderTop: "1px solid var(--border)", display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-primary" style={actionBtn} disabled={busy !== null} onClick={() => void act("refresh", () => hubApi.refresh(track.id))}>
          {busy === "refresh" ? "Перевіряю…" : "↻ Оновити"}
        </button>
        {track.trackUrl && (
          <a className="btn" style={{ ...actionBtn, textDecoration: "none", display: "inline-flex", alignItems: "center" }} href={track.trackUrl} target="_blank" rel="noreferrer noopener">
            Сайт перевізника ↗
          </a>
        )}
        <button type="button" className="btn" style={actionBtn} disabled={busy !== null} onClick={() => void act("archive", () => hubApi.patch(track.id, { archived: true })).then((ok) => ok && onRemoved())}>
          В архів
        </button>
        <button
          type="button"
          className="btn"
          style={{ ...actionBtn, color: "var(--err)" }}
          disabled={busy !== null}
          onClick={() => {
            if (!confirmDel) return setConfirmDel(true);
            void act("delete", () => hubApi.remove(track.id)).then((ok) => ok && onRemoved());
          }}
          onBlur={() => setConfirmDel(false)}
        >
          {confirmDel ? "Точно видалити?" : "Видалити"}
        </button>
      </div>
    </div>
  );
}

function TimelineItem({ e, color, first, dashed }: { e: TrackEvent; color: string; first?: boolean; dashed?: boolean }) {
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
        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
          {fmtDate(e.at, true)}
          {e.location ? ` · ${e.location}` : ""}
        </div>
      </div>
    </li>
  );
}

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

const actionBtn: React.CSSProperties = { height: 32, padding: "0 12px", fontSize: 12.5 };
