"use client";

// Hand-entered tracking data. Sea lines are tracked manually (no free carrier
// API covers them), so a logist keeps status, route, ETA, vessel and milestones
// up to date here; the same form also corrects any other item. Entering the
// vessel name/IMO lets the AIS layer show the real vessel position on the map.

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { hubApi, type ManualTrackInput, type Track, type TrackStatus } from "@/lib/hub";

const STATUS_OPTIONS: Array<[Exclude<TrackStatus, "pending">, string]> = [
  ["info", "Заброньовано / ще не відправлено"],
  ["in_transit", "В дорозі"],
  ["at_port", "У порту (перевантаження / прибуття)"],
  ["customs", "Митне оформлення"],
  ["out_for_delivery", "Доставка / вивезення з порту"],
  ["delivered", "Доставлено"],
  ["exception", "Проблема (затримка, арешт, огляд)"],
  ["unknown", "Немає даних"],
];

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");

export function ManualTrackForm({
  track,
  onSaved,
  onCancel,
}: {
  track: Track;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState({
    status: track.status === "pending" ? "in_transit" : track.status,
    statusText: track.statusText,
    origin: track.origin,
    destination: track.destination,
    vesselName: track.vesselName,
    vesselImo: track.vesselImo,
    departedAt: day(track.departedAt),
    eta: day(track.eta),
    arrivedAt: day(track.arrivedAt),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (f.vesselImo && !/^\d{7}$/.test(f.vesselImo.trim())) return setErr("IMO — це 7 цифр.");
    const manual: ManualTrackInput = {
      status: f.status as ManualTrackInput["status"],
      statusText: f.statusText.trim(),
      origin: f.origin.trim(),
      destination: f.destination.trim(),
      vesselName: f.vesselName.trim(),
      vesselImo: f.vesselImo.trim(),
      departedAt: f.departedAt || null,
      eta: f.eta || null,
      arrivedAt: f.arrivedAt || null,
    };
    setBusy(true);
    setErr(null);
    try {
      await hubApi.patch(track.id, { manual });
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Не вдалося зберегти.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} style={{ ...box, display: "grid", gap: 8 }} data-testid="hub-manual-form">
      <div style={{ fontSize: 13, fontWeight: 650 }}>Дані вантажу (вручну)</div>
      <Field label="Статус">
        <select value={f.status} onChange={set("status")} style={input}>
          {STATUS_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Коментар до статусу">
        <input value={f.statusText} onChange={set("statusText")} maxLength={300} placeholder="напр. «Перевантаження в Пірею»" style={input} />
      </Field>
      <div style={row}>
        <Field label="Звідки">
          <input value={f.origin} onChange={set("origin")} maxLength={200} placeholder="Ningbo" style={input} />
        </Field>
        <Field label="Куди">
          <input value={f.destination} onChange={set("destination")} maxLength={200} placeholder="Odesa" style={input} />
        </Field>
      </div>
      <div style={row}>
        <Field label="Вихід (ATD)">
          <input type="date" value={f.departedAt} onChange={set("departedAt")} style={input} />
        </Field>
        <Field label="ETA">
          <input type="date" value={f.eta} onChange={set("eta")} style={input} />
        </Field>
      </div>
      <Field label="Прибуло / доставлено">
        <input type="date" value={f.arrivedAt} onChange={set("arrivedAt")} style={input} />
      </Field>
      <div style={row}>
        <Field label="Судно">
          <input value={f.vesselName} onChange={set("vesselName")} maxLength={120} placeholder="MSC ANNA" style={input} />
        </Field>
        <Field label="IMO">
          <input value={f.vesselImo} onChange={set("vesselImo")} inputMode="numeric" maxLength={7} placeholder="9811000" style={input} />
        </Field>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
        Назва судна або IMO з коносамента — і карта покаже його реальну позицію (AIS).
      </div>
      {err && (
        <div role="alert" style={{ fontSize: 12.5, color: "var(--err)" }}>
          {err}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <button type="submit" className="btn btn-primary" disabled={busy} style={{ height: 32, fontSize: 12.5 }}>
          {busy ? "Зберігаю…" : "Зберегти"}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel} style={{ height: 32, fontSize: 12.5 }}>
          Скасувати
        </button>
      </div>
    </form>
  );
}

/** One-line milestone entry ("Вивантажено в Констанці", 12.10 14:30). */
export function ManualEventForm({ trackId, onSaved }: { trackId: string; onSaved: () => void }) {
  const [at, setAt] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [planned, setPlanned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) return setErr("Опишіть подію.");
    setBusy(true);
    setErr(null);
    try {
      await hubApi.addEvent(trackId, {
        at: at ? new Date(at).toISOString() : null,
        location: location.trim(),
        description: description.trim(),
        planned,
      });
      setAt("");
      setLocation("");
      setDescription("");
      setPlanned(false);
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Не вдалося додати подію.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={add} style={{ display: "grid", gap: 6, marginTop: 8 }} data-testid="hub-manual-event">
      <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Подія: напр. «Вивантажено з судна»" style={input} />
      <div style={row}>
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="Дата і час" style={input} />
        <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} placeholder="Місце" style={input} />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={planned} onChange={(e) => setPlanned(e.target.checked)} />
          план (ще не відбулось)
        </label>
        <button type="submit" className="btn" disabled={busy} style={{ height: 30, padding: "0 12px", fontSize: 12.5 }}>
          {busy ? "…" : "+ Додати подію"}
        </button>
      </div>
      {err && (
        <div role="alert" style={{ fontSize: 12.5, color: "var(--err)" }}>
          {err}
        </div>
      )}
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 650, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</span>
      {children}
    </label>
  );
}

const input: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 32,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 13,
  padding: "0 8px",
  boxSizing: "border-box",
};

const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };

const box: React.CSSProperties = { padding: 10, borderRadius: 10, background: "var(--hover)" };
