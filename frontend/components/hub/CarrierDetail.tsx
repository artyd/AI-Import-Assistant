"use client";

// Ocean-carrier card: Ukraine bookings / Asia–Europe routing / war-risk with the
// source of each (news link or a logist), one form to update them for the team,
// the services the team uses (with rotation drawn on the map), punctuality on our
// own deliveries, and which of my containers sail with this line.

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  ago,
  fmtDate,
  lineApi,
  RED_SEA_LABEL,
  statusColor,
  uaColor,
  UA_STATUS_LABEL,
  type CarrierDetailData,
  type FieldStatus,
  type RedSea,
  type Track,
  type UaStatus,
} from "@/lib/hub";
import { pill } from "./TracksPanel";
import { reliabilityText } from "./LinesPanel";

export function CarrierDetail({
  id,
  tracks,
  onClose,
  onChanged,
  onOpenTrack,
  onDetail,
}: {
  id: string;
  tracks: Track[];
  onClose: () => void;
  onChanged: () => void;
  onOpenTrack: (id: string) => void;
  onDetail?: (d: CarrierDetailData) => void;
}) {
  const [data, setData] = useState<CarrierDetailData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ua, setUa] = useState<UaStatus | "">("");
  const [rs, setRs] = useState<RedSea | "">("");
  const [wr, setWr] = useState("");
  const [note, setNote] = useState("");
  const [svcOpen, setSvcOpen] = useState(false);
  const [svc, setSvc] = useState({ name: "", rotation: "", min: "", max: "", frequency: "", via: "" as "" | "suez" | "cape" });

  const apply = useCallback(
    (d: CarrierDetailData) => {
      setData(d);
      onDetail?.(d);
    },
    [onDetail]
  );

  useEffect(() => {
    setData(null);
    setErr(null);
    lineApi
      .get(id)
      .then(apply)
      .catch(() => setErr("Не вдалося завантажити дані лінії."));
  }, [id, apply]);

  async function run(fn: () => Promise<CarrierDetailData | void>, after?: () => void) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fn();
      if (r) apply(r);
      else apply(await lineApi.get(id));
      after?.();
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Не вдалося зберегти.");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <div style={{ padding: 16, fontSize: 13, color: "var(--muted)" }}>{err ?? "Завантаження…"}</div>;
  }
  const c = data.carrier;
  const mine = tracks.filter((t) => t.carrier === id && t.status !== "delivered");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }} data-testid="hub-carrier-detail">
      <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>Морська лінія</div>
          <div style={{ fontSize: 18, fontWeight: 720 }}>{c.name}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>{reliabilityText(c.reliability)}</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Закрити" style={closeBtn}>
          ×
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "grid", gap: 16, alignContent: "start" }}>
        <section style={{ display: "grid", gap: 8 }}>
          <FieldRow title="Україна (Одеса / Дунай)" f={c.uaStatus} text={c.uaStatus ? UA_STATUS_LABEL[c.uaStatus.value] : null} color={uaColor(c.uaStatus?.value)} onConfirm={(m) => void run(() => lineApi.confirm(id, m))} busy={busy} />
          <FieldRow title="Азія → Європа" f={c.redSea} text={c.redSea ? RED_SEA_LABEL[c.redSea.value] : null} color={c.redSea?.value === "cape" ? "var(--warn)" : "var(--accent)"} onConfirm={(m) => void run(() => lineApi.confirm(id, m))} busy={busy} />
          <FieldRow title="Надбавка за воєнний ризик" f={c.warRisk} text={c.warRisk?.value || null} color="var(--err)" onConfirm={(m) => void run(() => lineApi.confirm(id, m))} busy={busy} />
        </section>

        <section>
          <div style={labelStyle}>Оновити для команди</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
            <select aria-label="Україна" value={ua} onChange={(e) => setUa(e.target.value as UaStatus | "")} style={input}>
              <option value="">Україна: без змін</option>
              {(Object.keys(UA_STATUS_LABEL) as UaStatus[]).map((k) => (
                <option key={k} value={k}>
                  {UA_STATUS_LABEL[k]}
                </option>
              ))}
            </select>
            <select aria-label="Маршрут Азія–Європа" value={rs} onChange={(e) => setRs(e.target.value as RedSea | "")} style={input}>
              <option value="">Маршрут: без змін</option>
              {(Object.keys(RED_SEA_LABEL) as RedSea[]).map((k) => (
                <option key={k} value={k}>
                  {RED_SEA_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <input aria-label="Надбавка за воєнний ризик" value={wr} onChange={(e) => setWr(e.target.value)} placeholder="Надбавка: напр. «WRS $150/TEU на Одесу»" style={{ ...input, width: "100%", marginTop: 6 }} />
          <input aria-label="Коментар" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Коментар / джерело (менеджер лінії, лист…)" style={{ ...input, width: "100%", marginTop: 6 }} />
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (!ua && !rs && !wr.trim() && !note.trim())}
            style={{ marginTop: 6, height: 32, padding: "0 12px", fontSize: 12.5 }}
            onClick={() =>
              void run(
                () => lineApi.mark(id, { uaStatus: ua || null, redSea: rs || null, warRisk: wr.trim() || undefined, note: note.trim() || undefined }),
                () => {
                  setUa("");
                  setRs("");
                  setWr("");
                  setNote("");
                }
              )
            }
          >
            Зберегти позначку
          </button>
          <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>Бачить уся команда; діє 14 днів.</div>
        </section>

        <section>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={labelStyle}>Сервіси команди</div>
            <button type="button" onClick={() => setSvcOpen((v) => !v)} style={linkBtn}>
              {svcOpen ? "Скасувати" : "+ Додати сервіс"}
            </button>
          </div>
          {svcOpen && (
            <div style={{ display: "grid", gap: 6, marginTop: 6, padding: 10, borderRadius: 10, background: "var(--hover)" }}>
              <input aria-label="Назва сервісу" value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} placeholder="Назва: напр. «AE-12 / Black Sea Express»" style={input} />
              <input
                aria-label="Ротація"
                value={svc.rotation}
                onChange={(e) => setSvc({ ...svc, rotation: e.target.value })}
                placeholder="Ротація кодами: CNSHA, CNNGB, SGSIN, TRAMR, UAODS"
                style={{ ...input, fontFamily: "var(--font-mono)", fontSize: 12 }}
              />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                <input aria-label="Транзит від" inputMode="numeric" value={svc.min} onChange={(e) => setSvc({ ...svc, min: e.target.value.replace(/\D/g, "") })} placeholder="Днів від" style={input} />
                <input aria-label="Транзит до" inputMode="numeric" value={svc.max} onChange={(e) => setSvc({ ...svc, max: e.target.value.replace(/\D/g, "") })} placeholder="до" style={input} />
                <select aria-label="Маршрут сервісу" value={svc.via} onChange={(e) => setSvc({ ...svc, via: e.target.value as "" | "suez" | "cape" })} style={input}>
                  <option value="">—</option>
                  <option value="suez">Суец</option>
                  <option value="cape">Африка</option>
                </select>
              </div>
              <input aria-label="Частота" value={svc.frequency} onChange={(e) => setSvc({ ...svc, frequency: e.target.value })} placeholder="Частота: щотижня / раз на 2 тижні" style={input} />
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !svc.name.trim() || svc.rotation.split(/[,\s→>]+/).filter(Boolean).length < 2}
                style={{ height: 32, fontSize: 12.5 }}
                onClick={() =>
                  void run(
                    () =>
                      lineApi.addService(id, {
                        name: svc.name.trim(),
                        rotation: svc.rotation.split(/[,\s→>]+/).filter(Boolean),
                        transitDaysMin: svc.min ? Number(svc.min) : null,
                        transitDaysMax: svc.max ? Number(svc.max) : null,
                        frequency: svc.frequency.trim(),
                        via: svc.via,
                      }),
                    () => {
                      setSvcOpen(false);
                      setSvc({ name: "", rotation: "", min: "", max: "", frequency: "", via: "" });
                    }
                  )
                }
              >
                Зберегти сервіс
              </button>
            </div>
          )}
          {data.services.length === 0 && !svcOpen ? (
            <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "6px 0 0" }}>Команда ще не додала сервісів цієї лінії.</p>
          ) : (
            <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
              {data.services.map((s) => (
                <div key={s.id} style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid var(--border)", fontSize: 12.5 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <b style={{ flex: 1 }}>{s.name}</b>
                    {s.transitDaysMin && (
                      <span style={{ fontWeight: 650 }}>
                        {s.transitDaysMin}
                        {s.transitDaysMax ? `–${s.transitDaysMax}` : ""} дн
                      </span>
                    )}
                    <button type="button" aria-label={`Видалити сервіс ${s.name}`} onClick={() => void run(() => lineApi.removeService(id, s.id))} style={{ ...linkBtn, color: "var(--muted)" }}>
                      ✕
                    </button>
                  </div>
                  <div style={{ color: "var(--muted)", marginTop: 2 }}>{s.rotation.map((r) => r.name).join(" → ")}</div>
                  <div style={{ color: "var(--faint)", fontSize: 11.5, marginTop: 2 }}>
                    {[s.frequency, s.via === "cape" ? "в обхід Африки" : s.via === "suez" ? "через Суец" : "", s.createdBy && `додав(ла) ${s.createdBy}`].filter(Boolean).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {mine.length > 0 && (
          <section>
            <div style={labelStyle}>Мої контейнери з цією лінією</div>
            <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
              {mine.map((t) => (
                <button key={t.id} type="button" onClick={() => onOpenTrack(t.id)} style={rowBtn}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(t.status) }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.label || t.number}</span>
                  <span style={{ color: "var(--muted)" }}>ETA {fmtDate(t.eta)}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {data.history.length > 0 && (
          <section>
            <div style={labelStyle}>Історія позначок</div>
            <ol style={{ listStyle: "none", padding: 0, margin: "6px 0 0", display: "grid", gap: 6 }}>
              {data.history.map((h) => (
                <li key={h.id} style={{ fontSize: 12, color: "var(--muted)" }}>
                  {fmtDate(h.createdAt, true)} · {h.by === "ai" ? "ШІ" : h.userName || "логіст"}:{" "}
                  <span style={{ color: "var(--text)" }}>
                    {[h.uaStatus && UA_STATUS_LABEL[h.uaStatus], h.redSea && RED_SEA_LABEL[h.redSea], h.warRisk, h.note].filter(Boolean).join(" · ")}
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

function FieldRow<T>({
  title,
  f,
  text,
  color,
  onConfirm,
  busy,
}: {
  title: string;
  f: FieldStatus<T> | null;
  text: string | null;
  color: string;
  onConfirm: (markId: string) => void;
  busy: boolean;
}) {
  return (
    <div style={{ padding: "9px 10px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)" }} data-testid="hub-carrier-field">
      <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 650, textTransform: "uppercase", letterSpacing: ".04em" }}>{title}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
        <span style={pill(f ? color : "var(--faint)")}>{text ?? "Невідомо"}</span>
        {f?.note && <span style={{ fontSize: 12, color: "var(--muted)", minWidth: 0 }}>{f.note}</span>}
      </div>
      {f && (
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span>
            {f.by === "ai" ? "🤖 ШІ з новини" : `👤 ${f.userName || "логіст"}`} · {ago(f.updatedAt)}
          </span>
          {f.sourceUrl && (
            <a href={f.sourceUrl} target="_blank" rel="noreferrer noopener" style={{ color: "var(--accent)" }}>
              джерело ↗
            </a>
          )}
          {f.by === "ai" && (
            <button type="button" disabled={busy} onClick={() => onConfirm(f.markId)} style={linkBtn}>
              ✓ підтвердити
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 650, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" };
const input: React.CSSProperties = {
  minWidth: 0,
  height: 34,
  padding: "0 9px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 12.5,
};
const linkBtn: React.CSSProperties = { background: "none", border: 0, padding: 0, color: "var(--accent)", font: "inherit", fontSize: 12, cursor: "pointer" };
const rowBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 12.5,
  cursor: "pointer",
  textAlign: "left",
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
