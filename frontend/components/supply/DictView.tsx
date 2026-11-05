"use client";

import { useState } from "react";
import type { SupplySettings } from "@/lib/supply/types";
import { IPlus, IX } from "./SupplyIcons";

/** Dictionaries: route templates, stage names, categories, extra fields. */
export function DictView({ settings, editing, onSave }: { settings: SupplySettings; editing: boolean; onSave: (s: SupplySettings) => Promise<boolean> }) {
  const [draft, setDraft] = useState<SupplySettings>(settings);
  const [base, setBase] = useState(settings);
  const [saving, setSaving] = useState(false);
  if (base !== settings && JSON.stringify(draft) === JSON.stringify(base)) {
    setBase(settings);
    setDraft(settings);
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const set = <K extends keyof SupplySettings>(k: K, v: SupplySettings[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

  if (!editing) {
    return (
      <div className="dictg">
        <div className="panel">
          <h4>Шаблони маршрутів</h4>
          {settings.templates.length ? settings.templates.map((t) => (
            <div className="tpl" key={t.id}><b>{t.name}</b><div>{t.stages.join(" → ")}</div></div>
          )) : <span style={{ color: "var(--muted)" }}>Шаблонів немає.</span>}
        </div>
        <div className="panel">
          <h4>Довідник етапів · {settings.stages.length}</h4>
          <div className="chips">{settings.stages.map((s) => <span key={s}>{s}</span>)}</div>
          <h4>Категорії</h4>
          <div className="chips">{settings.categories.map((c, i) => <span key={c} style={{ boxShadow: `inset 3px 0 0 var(--c-${i % 5 + 1})` }}>{c}</span>)}</div>
          <h4>Додаткові поля</h4>
          <div className="chips">{settings.fields.map((f) => <span key={f.id}>{f.name}</span>)}</div>
          <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Змінювати довідники можна з кодом Штурмана.</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="dictg">
        <div className="panel">
          <h4>Шаблони маршрутів</h4>
          {draft.templates.map((t, i) => (
            <div className="tpl" key={t.id}>
              <div style={{ display: "flex", gap: 6 }}>
                <input className="ed" value={t.name} aria-label="Назва шаблону" onChange={(e) => set("templates", draft.templates.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <button className="x" aria-label="Видалити шаблон" onClick={() => set("templates", draft.templates.filter((_, j) => j !== i))}><IX /></button>
              </div>
              <textarea className="ed" style={{ minHeight: 70 }} aria-label="Етапи шаблону, кожен з нового рядка" value={t.stages.join("\n")}
                onChange={(e) => set("templates", draft.templates.map((x, j) => (j === i ? { ...x, stages: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) } : x)))} />
            </div>
          ))}
          <button className="ghost" onClick={() => set("templates", [...draft.templates, { id: uid("t"), name: "Новий маршрут", stages: ["Готовність", "Доставка"] }])}><IPlus />Шаблон</button>
        </div>
        <div className="panel">
          <h4>Довідник етапів</h4>
          <ChipEditor values={draft.stages} placeholder="Новий етап" onChange={(v) => set("stages", v)} />
          <h4>Категорії</h4>
          <ChipEditor values={draft.categories} placeholder="Нова категорія" min={1} onChange={(v) => set("categories", v)} />
          <h4>Додаткові поля</h4>
          {draft.fields.map((f, i) => (
            <div key={f.id} style={{ display: "flex", gap: 6 }}>
              <input className="ed" value={f.name} aria-label="Назва поля" onChange={(e) => set("fields", draft.fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <button className="x" aria-label="Прибрати поле" onClick={() => set("fields", draft.fields.filter((_, j) => j !== i))}><IX /></button>
            </div>
          ))}
          <button className="ghost" onClick={() => set("fields", [...draft.fields, { id: uid("f"), name: "Нове поле", type: "text" }])}><IPlus />Поле</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="ghost" disabled={!dirty} onClick={() => setDraft(settings)}>Скасувати зміни</button>
        <button className="btn" disabled={!dirty || saving} onClick={async () => { setSaving(true); if (await onSave(draft)) setBase(draft); setSaving(false); }}>Зберегти довідники</button>
      </div>
    </div>
  );
}

function ChipEditor({ values, onChange, placeholder, min = 0 }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; min?: number }) {
  const [v, setV] = useState("");
  const add = () => {
    const t = v.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setV("");
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="chips">
        {values.map((x) => (
          <span key={x} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            {x}
            {values.length > min && (
              <button aria-label={`Прибрати ${x}`} onClick={() => onChange(values.filter((y) => y !== x))} style={{ border: 0, background: "transparent", cursor: "pointer", padding: 0, display: "grid", color: "var(--muted)" }}><IX size={12} /></button>
            )}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input className="ed" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <button className="ghost" disabled={!v.trim()} onClick={add}><IPlus /></button>
      </div>
    </div>
  );
}
