"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { categoryColor, currentStep, deadline, deadlineLabel, matches, shortDate } from "@/lib/supply/logic";
import type { SupplyShipment } from "@/lib/supply/types";

/** Ctrl/⌘ K: find a shipment by anything (name, step, supplier, note). */
export function Palette({ shipments, categories, today, onPick, onClose }: { shipments: SupplyShipment[]; categories: string[]; today: string; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const res = useMemo(() => shipments.filter((s) => matches(s, q)).sort((a, b) => Number(a.archived) - Number(b.archived)).slice(0, 12), [shipments, q]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setSel(0), [q]);

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="Пошук поставки">
        <input
          ref={input}
          value={q}
          placeholder="Товар, постачальник, етап, примітка…"
          aria-label="Пошук"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((n) => Math.min(res.length - 1, n + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((n) => Math.max(0, n - 1)); }
            if (e.key === "Enter" && res[sel]) onPick(res[sel]!.id);
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="pres">
          {res.length ? (
            res.map((s, i) => {
              const dl = deadline(s, today);
              return (
                <button key={s.id} className="pr" aria-selected={i === sel} style={{ ["--cc" as string]: categoryColor(categories, s.category) }} onMouseEnter={() => setSel(i)} onClick={() => onPick(s.id)}>
                  <i />
                  <span><b>{s.name}</b><small>{currentStep(s.steps)?.name ?? "Етап не задано"} · {s.category}{s.archived ? " · архів" : ""}</small></span>
                  <small style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{dl.kind === "none" ? "без дати" : `${shortDate(dl.date)} · ${deadlineLabel(dl)}`}</small>
                </button>
              );
            })
          ) : (
            <div className="empty" style={{ border: 0 }}>Нічого не знайдено</div>
          )}
        </div>
        <div className="pfoot"><span>↑↓ вибір</span><span>Enter відкрити</span><span>Esc закрити</span></div>
      </div>
    </div>
  );
}
