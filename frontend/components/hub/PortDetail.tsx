"use client";

// Port / airport / crossing card: current status with its source (news link or
// a logist's mark) and freshness, one-tap team marks, confirming an AI mark,
// ★ favourite, my shipments heading there, and the recent status history.

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  ago,
  fmtDate,
  PLACE_KIND_LABEL,
  PORT_STATUS_LABEL,
  portApi,
  portStatusColor,
  statusColor,
  type PortDetailData,
  type PortStatus,
} from "@/lib/hub";
import { pill } from "./TracksPanel";

const STATUSES: PortStatus[] = ["ok", "congested", "disrupted", "closed"];

export function PortDetail({
  code,
  onClose,
  onChanged,
  onOpenTrack,
}: {
  code: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenTrack: (id: string) => void;
}) {
  const [data, setData] = useState<PortDetailData | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    portApi
      .get(code)
      .then(setData)
      .catch(() => setErr("Не вдалося завантажити дані."));
  }, [code]);

  useEffect(() => {
    setData(null);
    setNote("");
    setErr(null);
    load();
  }, [load]);

  async function run(fn: () => Promise<PortDetailData | void>) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fn();
      if (r) setData(r);
      else load();
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Не вдалося зберегти.");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: "var(--muted)" }} data-testid="hub-port-detail">
        {err ?? "Завантаження…"}
      </div>
    );
  }
  const p = data.port;
  const s = p.status;
  const color = portStatusColor(s?.status);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }} data-testid="hub-port-detail">
      <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>
              {PLACE_KIND_LABEL[p.kind]} · {p.code}
            </div>
            <div style={{ fontSize: 18, fontWeight: 720 }}>
              {p.name} <span style={ccBadge}>{p.country}</span>
            </div>
            {p.nameEn && p.nameEn !== p.name && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{p.nameEn}</div>}
          </div>
          <button
            type="button"
            onClick={() => void run(() => portApi.favorite(p.code, !p.favorite))}
            aria-pressed={p.favorite}
            aria-label={p.favorite ? "Прибрати з обраних" : "Додати в обрані"}
            title={p.favorite ? "В обраних — сповіщатиму про зупинку/відновлення" : "Додати в обрані"}
            style={{ ...squareBtn, color: p.favorite ? "#f2b100" : "var(--muted)", fontSize: 17 }}
            disabled={busy}
          >
            {p.favorite ? "★" : "☆"}
          </button>
          <button type="button" onClick={onClose} aria-label="Закрити" style={squareBtn}>
            ×
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "grid", gap: 16, alignContent: "start" }}>
        <section
          style={{ padding: 12, borderRadius: 12, background: `color-mix(in srgb, ${color} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 35%, transparent)` }}
          data-testid="hub-port-status"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: color, flex: "none", boxShadow: `0 0 0 4px color-mix(in srgb, ${color} 25%, transparent)` }} />
            <b style={{ fontSize: 16 }}>{s ? s.label : "Немає даних"}</b>
          </div>
          {s ? (
            <div style={{ marginTop: 8, fontSize: 12.5, display: "grid", gap: 4 }}>
              {s.note && <div>{s.note}</div>}
              <div style={{ color: "var(--muted)" }}>
                {s.by === "ai" ? "🤖 ШІ з новини" : `👤 Позначка ${s.userName || "логіста"}`} · {ago(s.updatedAt)}
                {s.confirmations > 0 ? ` · підтвердили: ${s.confirmations}` : ""}
              </div>
              {s.sourceUrl && (
                <a href={s.sourceUrl} target="_blank" rel="noreferrer noopener" style={{ color: "var(--accent)", overflowWrap: "anywhere" }}>
                  {s.sourceTitle || "Джерело"} ↗
                </a>
              )}
              {s.by === "ai" && (
                <div style={{ marginTop: 4 }}>
                  <button type="button" className="btn" disabled={busy} style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={() => void run(() => portApi.confirm(p.code, s.markId))}>
                    ✓ Підтверджую
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--muted)" }}>
              За останні дні немає новин чи позначок команди про роботу цього обʼєкта. Хаб не припускає, що він працює.
            </div>
          )}
        </section>

        <section>
          <div style={labelStyle}>Позначити для команди</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
            {STATUSES.map((st) => (
              <button
                key={st}
                type="button"
                disabled={busy}
                onClick={() => void run(() => portApi.mark(p.code, st, note.trim() || undefined)).then(() => setNote(""))}
                style={{
                  height: 34,
                  borderRadius: 9,
                  border: `1px solid color-mix(in srgb, ${portStatusColor(st)} 45%, transparent)`,
                  background: `color-mix(in srgb, ${portStatusColor(st)} 9%, var(--surface))`,
                  color: "var(--text)",
                  font: "inherit",
                  fontSize: 12.5,
                  fontWeight: 620,
                  cursor: "pointer",
                }}
              >
                {PORT_STATUS_LABEL[st]}
              </button>
            ))}
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Коментар: напр. «черга 2 доби», «не приймають рефи»"
            aria-label="Коментар до статусу"
            style={{ width: "100%", marginTop: 6, height: 34, padding: "0 10px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", font: "inherit", fontSize: 12.5 }}
          />
          <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>Позначку бачить уся команда; діє 72 год.</div>
        </section>

        {data.tracks.length > 0 && (
          <section>
            <div style={labelStyle}>Мої вантажі сюди</div>
            <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
              {data.tracks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onOpenTrack(t.id)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", font: "inherit", fontSize: 12.5, cursor: "pointer", textAlign: "left" }}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.label || t.number}</span>
                  <span style={{ color: "var(--muted)" }}>ETA {fmtDate(t.eta)}</span>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(t.status) }} />
                </button>
              ))}
            </div>
          </section>
        )}

        {data.history.length > 1 && (
          <section>
            <div style={labelStyle}>Історія</div>
            <ol style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 6 }}>
              {data.history.slice(1).map((h) => (
                <li key={h.id} style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={pill(portStatusColor(h.status))}>{h.label}</span>
                  <span style={{ color: "var(--muted)", minWidth: 0 }}>
                    {fmtDate(h.createdAt, true)} · {h.by === "ai" ? "ШІ" : h.userName || "логіст"}
                    {h.note ? ` — ${h.note}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {err && (
          <div role="alert" style={{ fontSize: 12.5, color: "var(--err)" }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

const ccBadge: React.CSSProperties = {
  display: "inline-block",
  verticalAlign: "middle",
  marginLeft: 4,
  padding: "1px 6px",
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 650,
  color: "var(--muted)",
  background: "var(--hover)",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 650,
  color: "var(--muted)",
  textTransform: "uppercase",
  letterSpacing: ".05em",
};

const squareBtn: React.CSSProperties = {
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
