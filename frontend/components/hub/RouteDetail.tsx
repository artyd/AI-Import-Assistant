"use client";

// Route card: VIEW = plan vs fact per leg (planned window, projection with
// cascaded delays, tracking state), free time / demurrage on sea legs, totals;
// EDIT = the builder — Штурман's 2–3 variants from live hub data, multimodal
// legs (place picker or map click), carriers, dates, cost, free time, tracking.

import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  fmtDate,
  healthColor,
  HEALTH_LABEL,
  money,
  ROUTE_MODE_COLOR,
  ROUTE_MODE_ICON,
  ROUTE_MODE_LABEL,
  routeApi,
  statusColor,
  type CarrierRef,
  type HubPort,
  type LegDraft,
  type PlannedRoute,
  type RouteMode,
  type RouteVariant,
  type Track,
} from "@/lib/hub";
import { pill, type WorkspaceRef } from "./TracksPanel";

export type PickedPoint = { code?: string; name?: string; lat?: number; lng?: number };

const MODES: RouteMode[] = ["sea", "air", "road", "rail", "customs"];
const CURRENCIES = ["USD", "EUR", "UAH", "CNY"];

const dateOnly = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const toIso = (d: string) => (d ? new Date(`${d}T00:00:00Z`).toISOString() : null);

export function RouteDetail({
  routeId,
  ports,
  tracks,
  carriers,
  workspaces,
  defaultWorkspaceId,
  onClose,
  onSaved,
  onDeleted,
  onPick,
  onDraftChange,
  onOpenTrack,
}: {
  routeId: string | null;
  ports: HubPort[];
  tracks: Track[];
  carriers: CarrierRef[];
  workspaces: WorkspaceRef[];
  defaultWorkspaceId?: string;
  onClose: () => void;
  onSaved: (r: PlannedRoute) => void;
  onDeleted: () => void;
  onPick: (cb: ((p: PickedPoint) => void) | null) => void;
  onDraftChange: (legs: LegDraft[] | null) => void;
  onOpenTrack: (id: string) => void;
}) {
  const [route, setRoute] = useState<PlannedRoute | null>(null);
  const [mode, setMode] = useState<"view" | "edit">(routeId ? "view" : "edit");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  // Draft
  const [name, setName] = useState("");
  const [wsId, setWsId] = useState<string>(defaultWorkspaceId ?? "");
  const [status, setStatus] = useState<"draft" | "active" | "done">("draft");
  const [legs, setLegs] = useState<LegDraft[]>([]);

  // Suggestions
  const [sFrom, setSFrom] = useState("");
  const [sTo, setSTo] = useState("");
  const [sReady, setSReady] = useState(() => new Date().toISOString().slice(0, 10));
  const [sCargo, setSCargo] = useState("");
  const [sPrio, setSPrio] = useState<"reliability" | "speed" | "cost">("reliability");
  const [variants, setVariants] = useState<RouteVariant[] | null>(null);
  const [sBusy, setSBusy] = useState(false);

  const placeName = (code?: string) => ports.find((p) => p.code === code)?.name ?? code ?? "";

  function loadDraft(r: PlannedRoute | null) {
    setName(r?.name ?? "");
    setWsId(r?.workspaceId ?? defaultWorkspaceId ?? "");
    setStatus(r?.status ?? "draft");
    setLegs(
      (r?.legs ?? []).map((l) => ({
        mode: l.mode,
        from: l.from.code ? { code: l.from.code } : { name: l.from.name, lat: l.from.pos?.[0], lng: l.from.pos?.[1] },
        to: l.to.code ? { code: l.to.code } : { name: l.to.name, lat: l.to.pos?.[0], lng: l.to.pos?.[1] },
        carrier: l.carrier,
        via: l.via,
        trackedId: l.trackedId,
        plannedDeparture: l.plannedDeparture,
        plannedArrival: l.plannedArrival,
        costAmount: l.costAmount,
        costCurrency: l.costCurrency,
        freeDays: l.freeDays,
        demurragePerDay: l.demurragePerDay,
        notes: l.notes,
      }))
    );
  }

  useEffect(() => {
    setErr(null);
    setVariants(null);
    if (!routeId) {
      setRoute(null);
      loadDraft(null);
      setMode("edit");
      return;
    }
    routeApi
      .get(routeId)
      .then((r) => {
        setRoute(r.route);
        loadDraft(r.route);
      })
      .catch(() => setErr("Не вдалося завантажити маршрут."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  useEffect(() => {
    onDraftChange(mode === "edit" ? legs : null);
  }, [mode, legs, onDraftChange]);
  useEffect(() => () => {
    onDraftChange(null);
    onPick(null);
  }, [onDraftChange, onPick]);

  function setLeg(i: number, patch: Partial<LegDraft>) {
    setLegs((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  }
  function addLeg() {
    setLegs((ls) => {
      const prev = ls[ls.length - 1];
      const from = prev ? (prev.mode === "customs" ? prev.from : (prev.to ?? prev.from)) : {};
      return [...ls, { mode: prev ? "road" : "sea", from, to: {}, costCurrency: "USD", plannedDeparture: prev?.plannedArrival ?? null }];
    });
  }
  function move(i: number, d: -1 | 1) {
    setLegs((ls) => {
      const j = i + d;
      if (j < 0 || j >= ls.length) return ls;
      const c = [...ls];
      [c[i], c[j]] = [c[j]!, c[i]!];
      return c;
    });
  }

  async function suggest() {
    setSBusy(true);
    setErr(null);
    setVariants(null);
    try {
      const r = await routeApi.suggest({
        from: sFrom,
        to: sTo,
        readyDate: toIso(sReady) ?? undefined,
        cargo: sCargo.trim() || undefined,
        priority: sPrio,
      });
      setVariants(r.variants);
      if (r.variants.length === 0) setErr("Штурман не зміг скласти варіанти з наявних даних.");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Не вдалося отримати підказки.");
    } finally {
      setSBusy(false);
    }
  }

  function applyVariant(v: RouteVariant) {
    setLegs(
      v.legs.map((l) => ({
        mode: l.mode,
        from: l.from,
        to: l.to,
        carrier: l.carrier,
        via: l.via,
        plannedDeparture: l.plannedDeparture,
        plannedArrival: l.plannedArrival,
        costCurrency: "USD",
      }))
    );
    if (!name.trim()) setName(v.title);
    setVariants(null);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body = { name: name.trim() || "Маршрут", workspaceId: wsId || null, status, legs };
      const r = route ? await routeApi.update(route.id, body) : await routeApi.create(body);
      setRoute(r.route);
      loadDraft(r.route);
      setMode("view");
      onSaved(r.route);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Не вдалося зберегти маршрут.");
    } finally {
      setBusy(false);
    }
  }

  const placeOptions = useMemo(
    () => ports.map((p) => <option key={p.code} value={`${p.name} (${p.code})`} />),
    [ports]
  );

  // ── VIEW ──────────────────────────────────────────────────────────────────
  if (mode === "view") {
    if (!route) return <div style={{ padding: 16, fontSize: 13, color: "var(--muted)" }}>{err ?? "Завантаження…"}</div>;
    const s = route.summary;
    const color = healthColor(s.health);
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }} data-testid="hub-route-detail">
        <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>
              Маршрут{route.workspaceNumber ? ` · №${route.workspaceNumber}` : ""}
            </div>
            <div style={{ fontSize: 17, fontWeight: 720, overflowWrap: "anywhere" }}>{route.name}</div>
            <span style={{ ...pill(color), display: "inline-block", marginTop: 6 }}>{HEALTH_LABEL[s.health]}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Закрити" style={squareBtn}>
            ×
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "grid", gap: 14, alignContent: "start" }}>
          <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }} data-testid="hub-route-summary">
            <Kpi label="План прибуття" value={fmtDate(s.plannedEnd)} />
            <Kpi
              label="Прогноз"
              value={fmtDate(s.projectedEnd)}
              hint={s.delayDays ? `${s.delayDays > 0 ? "+" : ""}${s.delayDays} дн` : "у графіку"}
              color={s.delayDays > 0 ? "var(--err)" : "var(--ok)"}
            />
            <Kpi label="Відстань" value={`${s.distanceKm.toLocaleString("uk-UA")} км`} />
            <Kpi label="Вартість" value={money(s.costs)} />
            {Object.keys(s.demurrage).length > 0 && <Kpi label="Демередж (прогноз)" value={money(s.demurrage)} color="var(--err)" wide />}
          </section>

          <section>
            <div style={labelStyle}>План проти факту</div>
            <ol style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 8 }} data-testid="hub-route-legs">
              {route.legs.map((l, i) => {
                const c = l.computed;
                const st = c.fact?.state;
                return (
                  <li key={l.id} style={{ border: "1px solid var(--border)", borderLeft: `4px solid ${ROUTE_MODE_COLOR[l.mode]}`, borderRadius: 10, padding: "9px 10px", background: "var(--surface)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                      <span aria-hidden>{ROUTE_MODE_ICON[l.mode]}</span>
                      <b style={{ flex: 1, minWidth: 0 }}>
                        {i + 1}. {l.mode === "customs" ? `Митниця · ${l.from.name}` : `${l.from.name} → ${l.to.name}`}
                      </b>
                      {c.delayDays !== 0 && (
                        <span style={pill(c.delayDays > 0 ? "var(--err)" : "var(--ok)")}>
                          {c.delayDays > 0 ? "+" : ""}
                          {c.delayDays} дн
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 3 }}>
                      {ROUTE_MODE_LABEL[l.mode]}
                      {l.carrierName ? ` · ${l.carrierName}` : ""}
                      {l.via ? ` · ${l.via === "cape" ? "в обхід Африки" : "через Суец"}` : ""}
                      {c.distanceKm ? ` · ${c.distanceKm.toLocaleString("uk-UA")} км` : ""}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 8px", fontSize: 12, marginTop: 6 }}>
                      <span style={{ color: "var(--muted)" }}>План</span>
                      <span>
                        {fmtDate(c.plannedDeparture)} → {fmtDate(c.plannedArrival)}
                        {c.datesEstimated ? <span style={{ color: "var(--faint)" }}> (орієнтовно ~{c.estimatedDays} дн)</span> : null}
                      </span>
                      <span style={{ color: "var(--muted)" }}>{st === "done" ? "Факт" : "Прогноз"}</span>
                      <span style={{ color: c.delayDays > 0 ? "var(--err)" : "var(--text)" }}>
                        {fmtDate(c.fact?.departedAt ?? c.projectedDeparture)} → {fmtDate(st === "done" ? c.fact?.arrivedAt : c.projectedArrival)}
                      </span>
                    </div>
                    {l.tracked ? (
                      <button type="button" onClick={() => onOpenTrack(l.tracked!.id)} style={{ ...chipBtn, marginTop: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor(l.tracked.status) }} />
                        {l.tracked.label || l.tracked.number}
                        <span style={{ color: "var(--muted)" }}>· {st === "done" ? "виконано" : st === "in_progress" ? "в дорозі" : st === "no_data" ? "немає даних" : "очікує"}</span>
                      </button>
                    ) : (
                      l.mode !== "customs" && <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 5 }}>Трек не привʼязано — факт невідомий.</div>
                    )}
                    {c.freeTime && (
                      <div
                        data-testid="hub-free-time"
                        style={{
                          marginTop: 7,
                          padding: "6px 8px",
                          borderRadius: 8,
                          fontSize: 12,
                          background: c.freeTime.overDays > 0 ? "color-mix(in srgb, var(--err) 10%, transparent)" : "var(--hover)",
                          color: c.freeTime.overDays > 0 ? "var(--err)" : "var(--text)",
                        }}
                      >
                        ⏱ Free time {c.freeTime.freeDays} дн · до {fmtDate(c.freeTime.endsAt)}
                        {c.freeTime.daysLeft != null && c.freeTime.overDays === 0 ? ` · залишилось ${c.freeTime.daysLeft} дн` : ""}
                        {c.freeTime.overDays > 0
                          ? ` · демередж ${c.freeTime.overDays} дн × ${l.demurragePerDay ?? 0} = ${c.freeTime.demurrageCost.toLocaleString("uk-UA")} ${c.freeTime.currency}`
                          : ""}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
          {err && (
            <div role="alert" style={{ fontSize: 12.5, color: "var(--err)" }}>
              {err}
            </div>
          )}
        </div>
        <div style={{ padding: 12, borderTop: "1px solid var(--border)", display: "flex", gap: 6 }}>
          <button type="button" className="btn btn-primary" style={actBtn} onClick={() => setMode("edit")}>
            ✎ Редагувати
          </button>
          <button
            type="button"
            className="btn"
            style={{ ...actBtn, color: "var(--err)" }}
            onBlur={() => setConfirmDel(false)}
            onClick={async () => {
              if (!confirmDel) return setConfirmDel(true);
              try {
                await routeApi.remove(route.id);
                onDeleted();
              } catch {
                setErr("Не вдалося видалити.");
              }
            }}
          >
            {confirmDel ? "Точно видалити?" : "Видалити"}
          </button>
        </div>
      </div>
    );
  }

  // ── EDIT ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }} data-testid="hub-route-editor">
      <datalist id="hub-places">{placeOptions}</datalist>
      <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ flex: 1, fontSize: 16, fontWeight: 720 }}>{route ? "Редагування маршруту" : "Новий маршрут"}</div>
        <button type="button" onClick={() => (route ? setMode("view") : onClose())} aria-label="Закрити" style={squareBtn}>
          ×
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "grid", gap: 14, alignContent: "start" }}>
        <section style={{ display: "grid", gap: 6 }}>
          <input aria-label="Назва маршруту" value={name} onChange={(e) => setName(e.target.value)} placeholder="Назва: напр. «Метопрен Нінбо → Київ»" style={inp} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
            <select aria-label="Постачання" value={wsId} onChange={(e) => setWsId(e.target.value)} style={inp}>
              <option value="">Без привʼязки до постачання</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  №{w.number}
                  {w.supplier ? ` · ${w.supplier}` : ""}
                </option>
              ))}
            </select>
            <select aria-label="Статус маршруту" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} style={inp}>
              <option value="draft">Чернетка</option>
              <option value="active">Активний</option>
              <option value="done">Завершено</option>
            </select>
          </div>
        </section>

        <section style={{ padding: 10, borderRadius: 12, background: "var(--active)", display: "grid", gap: 6 }} data-testid="hub-route-suggest">
          <div style={{ fontWeight: 680, fontSize: 13 }}>🧭 Підказка Штурмана</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <input aria-label="Звідки" list="hub-places" value={sFrom} onChange={(e) => setSFrom(e.target.value)} placeholder="Звідки (Нінбо…)" style={inp} />
            <input aria-label="Куди" list="hub-places" value={sTo} onChange={(e) => setSTo(e.target.value)} placeholder="Куди (Київ…)" style={inp} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <input aria-label="Готовність вантажу" type="date" value={sReady} onChange={(e) => setSReady(e.target.value)} style={inp} />
            <select aria-label="Пріоритет" value={sPrio} onChange={(e) => setSPrio(e.target.value as typeof sPrio)} style={inp}>
              <option value="reliability">Надійність</option>
              <option value="speed">Швидкість</option>
              <option value="cost">Вартість</option>
            </select>
          </div>
          <input aria-label="Вантаж" value={sCargo} onChange={(e) => setSCargo(e.target.value)} placeholder="Вантаж (необовʼязково): субстанція, 2×40HC…" style={inp} />
          <button type="button" className="btn btn-primary" disabled={sBusy || sFrom.trim().length < 2 || sTo.trim().length < 2} onClick={() => void suggest()} style={{ height: 34 }}>
            {sBusy ? "Штурман думає…" : "Запропонувати варіанти"}
          </button>
          {variants && variants.length > 0 && (
            <div style={{ display: "grid", gap: 6 }} data-testid="hub-route-variants">
              {variants.map((v, i) => (
                <div key={i} style={{ background: "var(--surface)", borderRadius: 10, padding: 10, border: "1px solid var(--border)", fontSize: 12.5 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                    <b style={{ flex: 1 }}>{v.title}</b>
                    <span style={{ fontWeight: 700 }}>≈{v.totalDays} дн</span>
                  </div>
                  <div style={{ fontSize: 14, margin: "4px 0", letterSpacing: 1 }}>{v.legs.map((l) => ROUTE_MODE_ICON[l.mode]).join(" › ")}</div>
                  <div style={{ color: "var(--muted)" }}>{v.legs.map((l) => (l.mode === "customs" ? `митниця ${l.fromName}` : `${l.fromName}→${l.toName}`)).join(" · ")}</div>
                  <div style={{ marginTop: 4 }}>{v.summary}</div>
                  <div style={{ marginTop: 4, color: "var(--muted)" }}>
                    Вартість: {{ low: "нижча", medium: "середня", high: "вища" }[v.costLevel]} · прибуття ~{fmtDate(v.arrival)}
                  </div>
                  {v.risks.length > 0 && <div style={{ marginTop: 4, color: "var(--warn)" }}>⚠ {v.risks.join(" · ")}</div>}
                  <button type="button" className="btn" style={{ marginTop: 6, height: 28, fontSize: 12 }} onClick={() => applyVariant(v)}>
                    Застосувати
                  </button>
                </div>
              ))}
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Дорадчо. Терміни рахує хаб за відстанню; статуси — з позначок команди та новин.</div>
            </div>
          )}
        </section>

        <section>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={labelStyle}>Плечі ({legs.length})</div>
            <button type="button" onClick={addLeg} style={linkBtn} data-testid="hub-route-add-leg">
              + Додати плече
            </button>
          </div>
          <ol style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 8 }}>
            {legs.map((l, i) => (
              <li key={i} style={{ border: "1px solid var(--border)", borderLeft: `4px solid ${ROUTE_MODE_COLOR[l.mode]}`, borderRadius: 10, padding: 9, display: "grid", gap: 6, background: "var(--surface)" }} data-testid="hub-route-leg">
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <b style={{ fontSize: 12.5 }}>{i + 1}.</b>
                  <select aria-label={`Тип плеча ${i + 1}`} value={l.mode} onChange={(e) => setLeg(i, { mode: e.target.value as RouteMode })} style={{ ...inp, flex: 1 }}>
                    {MODES.map((m) => (
                      <option key={m} value={m}>
                        {ROUTE_MODE_ICON[m]} {ROUTE_MODE_LABEL[m]}
                      </option>
                    ))}
                  </select>
                  <button type="button" aria-label="Вгору" onClick={() => move(i, -1)} style={miniBtn}>
                    ↑
                  </button>
                  <button type="button" aria-label="Вниз" onClick={() => move(i, 1)} style={miniBtn}>
                    ↓
                  </button>
                  <button type="button" aria-label={`Видалити плече ${i + 1}`} onClick={() => setLegs((ls) => ls.filter((_, k) => k !== i))} style={{ ...miniBtn, color: "var(--err)" }}>
                    ✕
                  </button>
                </div>
                <PlaceField label={l.mode === "customs" ? "Пункт" : "Звідки"} value={l.from} placeName={placeName} ports={ports} onChange={(p) => setLeg(i, { from: p })} onPick={onPick} />
                {l.mode !== "customs" && <PlaceField label="Куди" value={l.to ?? {}} placeName={placeName} ports={ports} onChange={(p) => setLeg(i, { to: p })} onPick={onPick} />}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <input aria-label={`Відправлення ${i + 1}`} type="date" value={dateOnly(l.plannedDeparture)} onChange={(e) => setLeg(i, { plannedDeparture: toIso(e.target.value) })} style={inp} title="Плановий відхід" />
                  <input aria-label={`Прибуття ${i + 1}`} type="date" value={dateOnly(l.plannedArrival)} onChange={(e) => setLeg(i, { plannedArrival: toIso(e.target.value) })} style={inp} title="Планове прибуття (порожньо — оцінка хабу)" />
                </div>
                {(l.mode === "sea" || l.mode === "air") && (
                  <div style={{ display: "grid", gridTemplateColumns: l.mode === "sea" ? "1fr auto" : "1fr", gap: 6 }}>
                    <select aria-label={`Перевізник ${i + 1}`} value={l.carrier ?? ""} onChange={(e) => setLeg(i, { carrier: e.target.value })} style={inp}>
                      <option value="">Перевізник…</option>
                      {carriers
                        .filter((c) => c.mode === l.mode && !c.id.endsWith("generic"))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                    {l.mode === "sea" && (
                      <select aria-label={`Маршрут ${i + 1}`} value={l.via ?? ""} onChange={(e) => setLeg(i, { via: e.target.value as "" | "suez" | "cape" })} style={inp}>
                        <option value="">Найкоротший</option>
                        <option value="suez">Суец</option>
                        <option value="cape">Африка</option>
                      </select>
                    )}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
                  <input
                    aria-label={`Вартість ${i + 1}`}
                    inputMode="decimal"
                    value={l.costAmount ?? ""}
                    onChange={(e) => setLeg(i, { costAmount: e.target.value === "" ? null : Number(e.target.value.replace(",", ".")) || 0 })}
                    placeholder="Вартість"
                    style={inp}
                  />
                  <select aria-label={`Валюта ${i + 1}`} value={l.costCurrency ?? "USD"} onChange={(e) => setLeg(i, { costCurrency: e.target.value })} style={inp}>
                    {CURRENCIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </div>
                {l.mode === "sea" && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <input aria-label={`Free time ${i + 1}`} inputMode="numeric" value={l.freeDays ?? ""} onChange={(e) => setLeg(i, { freeDays: e.target.value === "" ? null : Number(e.target.value.replace(/\D/g, "")) })} placeholder="Free time, дн" style={inp} />
                    <input aria-label={`Демередж ${i + 1}`} inputMode="decimal" value={l.demurragePerDay ?? ""} onChange={(e) => setLeg(i, { demurragePerDay: e.target.value === "" ? null : Number(e.target.value.replace(",", ".")) || 0 })} placeholder="Демередж / день" style={inp} />
                  </div>
                )}
                {l.mode !== "customs" && (
                  <select aria-label={`Трек ${i + 1}`} value={l.trackedId ?? ""} onChange={(e) => setLeg(i, { trackedId: e.target.value || null })} style={inp}>
                    <option value="">Трек-номер для факту (необовʼязково)</option>
                    {tracks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label ? `${t.label} · ` : ""}
                        {t.number} ({t.carrierName})
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ol>
          {legs.length === 0 && <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Додайте плечі вручну або застосуйте варіант Штурмана.</p>}
        </section>
        {err && (
          <div role="alert" style={{ fontSize: 12.5, color: "var(--err)" }}>
            {err}
          </div>
        )}
      </div>
      <div style={{ padding: 12, borderTop: "1px solid var(--border)", display: "flex", gap: 6 }}>
        <button type="button" className="btn btn-primary" style={actBtn} disabled={busy || legs.length === 0} onClick={() => void save()} data-testid="hub-route-save">
          {busy ? "Зберігаю…" : "Зберегти маршрут"}
        </button>
        <button type="button" className="btn" style={actBtn} onClick={() => (route ? setMode("view") : onClose())}>
          Скасувати
        </button>
      </div>
    </div>
  );
}

function PlaceField({
  label,
  value,
  placeName,
  ports,
  onChange,
  onPick,
}: {
  label: string;
  value: PickedPoint;
  placeName: (code?: string) => string;
  ports: HubPort[];
  onChange: (p: PickedPoint) => void;
  onPick: (cb: ((p: PickedPoint) => void) | null) => void;
}) {
  const shown = value.code ? `${placeName(value.code)} (${value.code})` : value.name ?? "";
  const [text, setText] = useState(shown);
  const [picking, setPicking] = useState(false);
  useEffect(() => setText(shown), [shown]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
      <input
        aria-label={label}
        list="hub-places"
        value={text}
        placeholder={`${label}: порт, аеропорт, місто…`}
        onChange={(e) => {
          setText(e.target.value);
          const m = e.target.value.match(/\(([A-Z]{3,5})\)\s*$/);
          const code = m?.[1] ?? (ports.some((p) => p.code === e.target.value.trim().toUpperCase()) ? e.target.value.trim().toUpperCase() : undefined);
          if (code) onChange({ code });
        }}
        style={{ ...inp, borderColor: text && !value.code && value.lat == null ? "var(--warn)" : undefined }}
      />
      <button
        type="button"
        title="Обрати на карті"
        aria-label={`${label}: обрати на карті`}
        aria-pressed={picking}
        onClick={() => {
          if (picking) {
            setPicking(false);
            onPick(null);
            return;
          }
          setPicking(true);
          onPick((p) => {
            setPicking(false);
            onChange(p);
          });
        }}
        style={{ ...miniBtn, width: 34, height: 34, background: picking ? "var(--active)" : "var(--surface)" }}
      >
        📍
      </button>
    </div>
  );
}

function Kpi({ label, value, hint, color, wide }: { label: string; value: string; hint?: string; color?: string; wide?: boolean }) {
  return (
    <div style={{ padding: "8px 10px", borderRadius: 10, background: "var(--hover)", gridColumn: wide ? "1 / -1" : undefined }}>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: color ?? "var(--text)" }}>{value}</div>
      {hint && <div style={{ fontSize: 11.5, color: color ?? "var(--muted)" }}>{hint}</div>}
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 650, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" };
const inp: React.CSSProperties = {
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
const linkBtn: React.CSSProperties = { background: "none", border: 0, padding: 0, color: "var(--accent)", font: "inherit", fontSize: 12.5, fontWeight: 600, cursor: "pointer" };
const miniBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  lineHeight: 1,
};
const chipBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
};
const actBtn: React.CSSProperties = { height: 32, padding: "0 12px", fontSize: 12.5 };
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
