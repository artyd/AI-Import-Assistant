"use client";

import { useMemo, useRef, useState } from "react";
import { MONTHS, MONTHS_GEN, WEEKDAYS, addDays, currentStep, deadline, eventsByDay, monthGrid, shortDate, type CalendarEvent } from "@/lib/supply/logic";
import type { SupplyShipment } from "@/lib/supply/types";

const TONE: Record<CalendarEvent["tone"], string> = { done: "var(--ok)", active: "var(--accent)", pending: "var(--faint)", overdue: "var(--err)" };

export function CalendarView({
  list, today, editing, onOpen, onReschedule,
}: {
  list: SupplyShipment[];
  categories: string[];
  today: string;
  editing: boolean;
  onOpen: (id: string) => void;
  onReschedule: (s: SupplyShipment, stepIndex: number, day: string) => void;
}) {
  const [month, setMonth] = useState(() => [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1] as [number, number]);
  const [over, setOver] = useState<string | null>(null);
  const drag = useRef<{ id: string; index: number } | null>(null);
  const events = useMemo(() => eventsByDay(list, today), [list, today]);
  const days = useMemo(() => monthGrid(month[0], month[1]), [month]);
  const shift = (k: number) => setMonth(([y, m]) => (m + k < 0 ? [y - 1, 11] : m + k > 11 ? [y + 1, 0] : [y, m + k]));

  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i))
    .map((day) => ({ day, items: (events.get(day) ?? []).filter((e) => e.tone !== "done" || day === today) }))
    .filter((d) => d.items.length);
  const overdue = list.filter((s) => deadline(s, today).kind === "overdue");
  const undated = list.filter((s) => deadline(s, today).kind === "none");

  return (
    <div className="calwrap">
      <div className="cal">
        <div className="calhead">
          <h3>{MONTHS[month[1]]} {month[0]}</h3>
          <button onClick={() => setMonth([Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1])}>Сьогодні</button>
          <button onClick={() => shift(-1)} aria-label="Попередній місяць">‹</button>
          <button onClick={() => shift(1)} aria-label="Наступний місяць">›</button>
        </div>
        <div className="grid7">
          {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"].map((d) => <div key={d} className="dow">{d}</div>)}
        </div>
        <div className="grid7 days-grid">
          {days.map((day) => {
            const items = events.get(day) ?? [];
            const out = Number(day.slice(5, 7)) - 1 !== month[1];
            return (
              <div
                key={day}
                className={`day${out ? " out" : ""}${day === today ? " today" : ""}${over === day ? " dragover" : ""}`}
                onDragOver={(e) => { if (drag.current) { e.preventDefault(); setOver(day); } }}
                onDragLeave={() => setOver((o) => (o === day ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const d = drag.current;
                  drag.current = null;
                  const s = d && list.find((x) => x.id === d.id);
                  if (s && d) onReschedule(s, d.index, day);
                }}
              >
                <span className="n tn">{Number(day.slice(8, 10))}</span>
                {items.slice(0, 2).map((e) => (
                  <button
                    key={`${e.shipment.id}-${e.index}`}
                    className={`ev${e.tone === "done" ? " done" : ""}`}
                    style={{ ["--ec" as string]: TONE[e.tone] }}
                    title={`${e.shipment.name} · ${e.step.name}`}
                    draggable={editing && e.tone !== "done" && !!e.step.plan}
                    onDragStart={(ev) => { drag.current = { id: e.shipment.id, index: e.index }; ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", e.shipment.id); }}
                    onDragEnd={() => { drag.current = null; setOver(null); }}
                    onClick={() => onOpen(e.shipment.id)}
                  >
                    {e.shipment.name} · {e.step.name}
                  </button>
                ))}
                {items.length > 2 && <span className="more">ще {items.length - 2}</span>}
              </div>
            );
          })}
        </div>
        <div className="legend">
          <span><i style={{ background: "var(--accent)" }} />Поточний етап</span>
          <span><i style={{ background: "var(--faint)" }} />Наступні</span>
          <span><i style={{ background: "var(--ok)" }} />Факт</span>
          <span><i style={{ background: "var(--err)" }} />Прострочено</span>
          {editing && <span>Перетягніть подію, щоб змінити планову дату</span>}
        </div>
      </div>

      <aside className="agenda">
        <h4>Найближчий тиждень</h4>
        {week.length ? (
          week.map(({ day, items }, i) => {
            const d = new Date(`${day}T12:00:00Z`);
            const label = i === 0 && day === today ? "Сьогодні" : day === addDays(today, 1) ? "Завтра" : WEEKDAYS[d.getUTCDay()];
            return (
              <div className="dg" key={day}>
                <span className={`dl${day === today ? " t" : ""}`}>{label} · {d.getUTCDate()} {MONTHS_GEN[d.getUTCMonth()]}</span>
                {items.map((e) => (
                  <button key={`${e.shipment.id}-${e.index}`} className="ai" style={{ ["--ec" as string]: TONE[e.tone] }} onClick={() => onOpen(e.shipment.id)}>
                    <i />
                    <span><b>{e.shipment.name}</b><small>{e.step.name}{e.tone === "done" ? " · факт" : ""}</small></span>
                  </button>
                ))}
              </div>
            );
          })
        ) : (
          <span style={{ color: "var(--muted)" }}>Подій немає</span>
        )}
        {overdue.length > 0 && (
          <div className="dg">
            <span className="dl" style={{ color: "var(--err)" }}>Прострочено · {overdue.length}</span>
            {overdue.map((s) => {
              const dl = deadline(s, today);
              return (
                <button key={s.id} className="ai" style={{ ["--ec" as string]: "var(--err)" }} onClick={() => onOpen(s.id)}>
                  <i />
                  <span><b>{s.name}</b><small>{dl.step?.name} · план {shortDate(dl.date)}</small></span>
                </button>
              );
            })}
          </div>
        )}
        {undated.length > 0 && (
          <div className="dg">
            <span className="dl">Без дати · {undated.length}</span>
            {undated.map((s) => (
              <button key={s.id} className="ai" style={{ ["--ec" as string]: "var(--faint)" }} onClick={() => onOpen(s.id)}>
                <i />
                <span><b>{s.name}</b><small>{currentStep(s.steps)?.name ?? "Етап не задано"}</small></span>
              </button>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
