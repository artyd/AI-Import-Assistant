"use client";

import { useEffect, useMemo, useState } from "react";
import { supplyApi } from "@/lib/supply/api";
import { categoryColor, currentStep, daysBetween, deadline, newStepId, normalizeSteps, shortDate } from "@/lib/supply/logic";
import type { ShipmentDraft, SupplyHistoryEntry, SupplySettings, SupplyShipment, SupplyStep } from "@/lib/supply/types";
import { IArch, ICheck, IDown, IFlag, ILock, IPlus, ITrash, IUnlock, IUp, IX } from "./SupplyIcons";

function toDraft(s: SupplyShipment | null, category: string): ShipmentDraft {
  return s
    ? { name: s.name, category: s.category, action: s.action, note: s.note, steps: s.steps, custom: { ...s.custom } }
    : { name: "", category, action: "", note: "", steps: [], custom: {} };
}

export function ShipmentDrawer({
  open, shipment, settings, defaultCategory, editing, today, onClose, onSave, onArchive, onComplete, onUnlock,
}: {
  open: boolean;
  shipment: SupplyShipment | null;
  settings: SupplySettings;
  defaultCategory: string;
  editing: boolean;
  today: string;
  onClose: () => void;
  onSave: (s: SupplyShipment | null, d: ShipmentDraft) => Promise<boolean>;
  onArchive: (s: SupplyShipment, archived: boolean) => void;
  onComplete: (s: SupplyShipment) => void;
  onUnlock: () => void;
}) {
  const creating = open && !shipment;
  const [shown, setShown] = useState(false);
  const [draft, setDraft] = useState<ShipmentDraft>(() => toDraft(shipment, defaultCategory));
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<SupplyHistoryEntry[]>([]);
  const [newStage, setNewStage] = useState("");

  useEffect(() => {
    if (!open) return setShown(false);
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, [open]);

  // Someone else saved this shipment while it is open and untouched → show theirs.
  const pristine = useMemo(() => JSON.stringify(toDraft(shipment, defaultCategory)), [shipment, defaultCategory]);
  const [base, setBase] = useState(pristine);
  const dirty = JSON.stringify(draft) !== base;
  useEffect(() => {
    if (!dirty) {
      setDraft(toDraft(shipment, defaultCategory));
      setBase(pristine);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pristine]);

  useEffect(() => {
    if (!shipment) return;
    supplyApi.history(shipment.id).then((r) => setHistory(r.history.slice(0, 5))).catch(() => setHistory([]));
  }, [shipment, shipment?.updatedAt]);

  if (!open) return null;
  const cc = categoryColor(settings.categories, draft.category);
  const edit = editing;
  const set = <K extends keyof ShipmentDraft>(k: K, v: ShipmentDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setSteps = (steps: SupplyStep[]) => set("steps", normalizeSteps(steps));
  const patchStep = (i: number, p: Partial<SupplyStep>) => setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) }));
  const addStages = (names: string[]) =>
    setSteps([...draft.steps, ...names.filter(Boolean).map((name) => ({ id: newStepId(), name, plan: "", actual: "", state: "pending" as const, note: "" }))]);

  const view = shipment && !edit;
  const s = shipment;
  const done = draft.steps.filter((x) => x.state === "done").length;
  const pct = draft.steps.length ? done / draft.steps.length : 0;
  const dl = deadline({ steps: draft.steps }, today);
  const cur = currentStep(draft.steps);
  const C = 2 * Math.PI * 19;

  const save = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    const ok = await onSave(s, { ...draft, name: draft.name.trim(), steps: normalizeSteps(draft.steps) });
    setSaving(false);
    if (ok) setBase(JSON.stringify(draft));
  };

  return (
    <>
      <div className={`scrim${shown ? " on" : ""}`} onClick={onClose} />
      <aside className={`drawer${shown ? " on" : ""}`} aria-label={creating ? "Нова поставка" : "Картка поставки"} style={{ ["--cc" as string]: cc }}>
        <div className="dh">
          <div className="r1">
            {edit ? (
              <input className="ed" style={{ fontFamily: "var(--display)", fontSize: 19, fontWeight: 700, letterSpacing: "-0.03em" }} value={draft.name}
                placeholder="Назва товару / партії" aria-label="Назва" autoFocus={creating} onChange={(e) => set("name", e.target.value)} />
            ) : (
              <h2>{draft.name}</h2>
            )}
            <button className="x" onClick={onClose} aria-label="Закрити"><IX /></button>
          </div>
          <div className="meta">
            {edit ? (
              <select className="ed" style={{ width: "auto", padding: "4px 8px" }} value={draft.category} aria-label="Категорія" onChange={(e) => set("category", e.target.value)}>
                {settings.categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : (
              <span className="chip"><i />{draft.category}</span>
            )}
            {s && <span className="chip">Оновлено {shortDate(s.updatedAt.slice(0, 10))}</span>}
            {s?.archived && <span className="chip">В архіві</span>}
            {dl.kind === "overdue" && <span className="chip" style={{ color: "var(--err)" }}>Прострочено</span>}
            {dl.kind === "soon" && <span className="chip" style={{ color: "var(--warn)" }}>Найближчі 7 днів</span>}
          </div>
          {draft.steps.length > 0 && (
            <div className="ring">
              <svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">
                <circle cx="23" cy="23" r="19" fill="none" stroke="var(--sunk)" strokeWidth="6" />
                <circle cx="23" cy="23" r="19" fill="none" stroke="var(--ok)" strokeWidth="6" strokeLinecap="round" strokeDasharray={C.toFixed(1)}
                  strokeDashoffset={(C * (1 - pct)).toFixed(1)} transform="rotate(-90 23 23)" style={{ transition: "stroke-dashoffset .8s" }} />
                <text x="23" y="27" textAnchor="middle" fontSize="12" fontWeight="800" fill="var(--text)">{done}/{draft.steps.length}</text>
              </svg>
              <div>
                <b>{cur?.name ?? "Етап не задано"}</b>
                <small>
                  {dl.kind === "none" ? "Планової дати немає" : dl.kind === "done" ? "Етап виконано" : `План ${shortDate(dl.date)} · ${dl.kind === "overdue" ? `прострочено ${-(dl.days ?? 0)} дн.` : dl.days === 0 ? "сьогодні" : `через ${dl.days} дн.`}`}
                </small>
              </div>
              {edit && s && !dirty && s.steps.some((x) => x.state === "active") && (
                <button className="qb okb" style={{ marginLeft: "auto" }} onClick={() => onComplete(s)}><ICheck />Виконано</button>
              )}
            </div>
          )}
        </div>

        <div className="db">
          {creating && settings.templates.length > 0 && draft.steps.length === 0 && (
            <div className="sec">
              <h5>Маршрут</h5>
              <div className="chips">
                {settings.templates.map((t) => (
                  <button key={t.id} className="ghost" onClick={() => addStages(t.stages)} title={t.stages.join(" → ")}>{t.name}</button>
                ))}
              </div>
            </div>
          )}

          <div className="sec">
            <h5>Наступна дія</h5>
            {edit ? (
              <input className="ed" value={draft.action} placeholder="Що потрібно вирішити?" onChange={(e) => set("action", e.target.value)} />
            ) : (
              <div className={`nextbox${draft.action ? "" : " none"}`}><IFlag size={16} />{draft.action || "Дій не потрібно"}</div>
            )}
          </div>

          <div className="sec">
            <h5>Етапи · план і факт</h5>
            {draft.steps.length === 0 && <div className="notebox" style={{ color: "var(--muted)" }}>Етапів ще немає.</div>}
            <div className="tl">
              {draft.steps.map((st, i) => {
                const over = !st.actual && st.plan && st.plan < today && st.state !== "done";
                return (
                  <div key={st.id} className={`st ${st.state}`} style={{ animationDelay: `${i * 50}ms` }}>
                    <button
                      className="dot"
                      disabled={!edit}
                      title={edit ? (st.state === "done" ? "Зняти позначку «виконано»" : "Позначити виконаним") : undefined}
                      style={{ cursor: edit ? "pointer" : "default" }}
                      onClick={() => setSteps(draft.steps.map((x, j) => (j === i ? { ...x, state: x.state === "done" ? "pending" : "done", actual: x.state === "done" ? x.actual : x.actual || today } : x)))}
                    >
                      {st.state === "done" ? <ICheck /> : i + 1}
                    </button>
                    {edit ? (
                      <>
                        <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
                          <input className="ed" list="sp-stages" value={st.name} aria-label="Назва етапу" onChange={(e) => patchStep(i, { name: e.target.value })} />
                          <input className="ed" value={st.note} placeholder="Коментар до етапу" aria-label="Коментар" style={{ fontSize: 12.5, padding: "5px 8px" }} onChange={(e) => patchStep(i, { note: e.target.value })} />
                        </div>
                        <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
                          <label className="sp-date">план<input type="date" className="ed" value={st.plan} onChange={(e) => patchStep(i, { plan: e.target.value })} /></label>
                          <label className="sp-date">факт<input type="date" className="ed" value={st.actual} onChange={(e) => patchStep(i, { actual: e.target.value })} /></label>
                          <span style={{ display: "flex", gap: 4 }}>
                            <button className="x" style={{ width: 28, height: 28 }} disabled={i === 0} aria-label="Вище" onClick={() => { const a = [...draft.steps]; [a[i - 1], a[i]] = [a[i]!, a[i - 1]!]; setSteps(a); }}><IUp /></button>
                            <button className="x" style={{ width: 28, height: 28 }} disabled={i === draft.steps.length - 1} aria-label="Нижче" onClick={() => { const a = [...draft.steps]; [a[i + 1], a[i]] = [a[i]!, a[i + 1]!]; setSteps(a); }}><IDown /></button>
                            <button className="x" style={{ width: 28, height: 28 }} aria-label="Прибрати етап" onClick={() => setSteps(draft.steps.filter((_, j) => j !== i))}><ITrash /></button>
                          </span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="sn">{st.name}{st.note && <small>{st.note}</small>}</div>
                        <div className="dd">
                          <span>план <b className="tn">{shortDate(st.plan) || "—"}</b></span>
                          {st.actual ? <span>факт <b className="tn">{shortDate(st.actual)}</b></span> : over ? <span className="o">прострочено {-daysBetween(today, st.plan)} дн.</span> : null}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {edit && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                <input className="ed" list="sp-stages" style={{ flex: "1 1 160px", width: "auto" }} value={newStage} placeholder="Новий етап…"
                  onChange={(e) => setNewStage(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newStage.trim()) { addStages([newStage.trim()]); setNewStage(""); } }} />
                <button className="ghost" disabled={!newStage.trim()} onClick={() => { addStages([newStage.trim()]); setNewStage(""); }}><IPlus />Етап</button>
                {settings.templates.length > 0 && (
                  <select className="sort" value="" aria-label="Додати етапи з шаблону" onChange={(e) => { const t = settings.templates.find((x) => x.id === e.target.value); if (t) addStages(t.stages); }}>
                    <option value="">+ з шаблону…</option>
                    {settings.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                )}
                <datalist id="sp-stages">{settings.stages.map((x) => <option key={x} value={x} />)}</datalist>
              </div>
            )}
          </div>

          <div className="sec">
            <h5>Примітка</h5>
            {edit ? (
              <textarea className="ed" value={draft.note} onChange={(e) => set("note", e.target.value)} />
            ) : (
              <div className="notebox">{draft.note || "—"}</div>
            )}
          </div>

          {settings.fields.length > 0 && (
            <div className="sec">
              <h5>Інформація</h5>
              <dl className="kv">
                {settings.fields.map((f) => (
                  <div key={f.id} style={{ display: "contents" }}>
                    <dt>{f.name}</dt>
                    <dd>
                      {edit ? (
                        <input className="ed" inputMode={f.type === "number" ? "decimal" : undefined} value={draft.custom[f.id] ?? ""}
                          onChange={(e) => set("custom", { ...draft.custom, [f.id]: e.target.value })} />
                      ) : (
                        draft.custom[f.id] || "—"
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {s && history.length > 0 && (
            <div className="sec">
              <h5>Останні зміни</h5>
              <div className="hmini">
                {history.map((h) => (
                  <span key={h.id}>{shortDate(h.at.slice(0, 10))} · {h.text}{h.actor ? ` · ${h.actor}` : ""}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="df">
          {view ? (
            <>
              <span className="msg"><ILock size={13} />Лише перегляд</span>
              <button className="btn" onClick={onUnlock}><IUnlock size={14} />Редагувати</button>
            </>
          ) : (
            <>
              <span className="msg">{dirty ? "Є незбережені зміни" : creating ? "Нова поставка" : "Зміни підуть в історію"}</span>
              {s && <button className="ghost" onClick={() => onArchive(s, !s.archived)}><IArch size={14} />{s.archived ? "Відновити" : "В архів"}</button>}
              <button className="btn" disabled={saving || !draft.name.trim() || (!dirty && !creating)} onClick={save}>{creating ? "Додати" : "Зберегти"}</button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
