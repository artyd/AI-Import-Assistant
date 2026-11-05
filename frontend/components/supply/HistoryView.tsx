"use client";

import { useEffect, useState } from "react";
import { supplyApi } from "@/lib/supply/api";
import type { SupplyHistoryEntry } from "@/lib/supply/types";

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export function HistoryView({ revision, editing, onUndo }: { revision: string; editing: boolean; onUndo: (id: number) => Promise<void> }) {
  const [list, setList] = useState<SupplyHistoryEntry[] | null>(null);

  useEffect(() => {
    supplyApi.history().then((r) => setList(r.history)).catch(() => setList([]));
  }, [revision]);

  if (!list) return <div className="empty"><b>Завантажуємо історію…</b></div>;
  if (!list.length) return <div className="empty"><b>Змін ще немає</b>Тут зʼявиться, хто, коли і що змінив у реєстрі.</div>;

  return (
    <div className="panel">
      {list.map((h, i) => (
        <div className="hrow" key={h.id} style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
          <time className="tn">{fmt(h.at)}</time>
          <span>
            {h.text}
            {h.actor && <small style={{ color: "var(--muted)" }}> · {h.actor}</small>}
          </span>
          {editing && h.undoable ? <button className="ghost" onClick={() => void onUndo(h.id)}>Відкотити</button> : <span />}
        </div>
      ))}
    </div>
  );
}
