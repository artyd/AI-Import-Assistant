"use client";

import { categoryColor, currentStep, deadline, deadlineLabel, shortDate, sortShipments, type SortKey } from "@/lib/supply/logic";
import type { SupplyShipment } from "@/lib/supply/types";
import { IArch, ICheck, IChev, IFlag } from "./SupplyIcons";

const BADGE: Record<string, string> = { overdue: "b-over", soon: "b-soon", later: "b-later", none: "b-none", done: "b-ok" };

export function ListView({
  list, categories, sort, today, editing, onOpen, onComplete, archive, onRestore,
}: {
  list: SupplyShipment[];
  categories: string[];
  sort: SortKey;
  today: string;
  editing: boolean;
  onOpen: (id: string) => void;
  onComplete?: (s: SupplyShipment) => void;
  archive?: boolean;
  onRestore?: (s: SupplyShipment) => void;
}) {
  if (!list.length) {
    return archive ? (
      <div className="empty">
        <span style={{ color: "var(--faint)" }}><IArch size={34} /></span>
        <b>Архів порожній</b>
        Завершені поставки переносяться сюди з картки. Звідси їх можна відновити.
      </div>
    ) : (
      <div className="empty">
        <b>Тут поки порожньо</b>
        {editing ? "Додайте першу поставку кнопкою «Нова поставка»." : "Поставок у цій категорії немає."}
      </div>
    );
  }

  return (
    <div className="list">
      {sortShipments(list, sort, today).map((s, i) => {
        const st = currentStep(s.steps);
        const dl = deadline(s, today);
        const done = s.steps.filter((x) => x.state === "done").length;
        return (
          <article
            key={s.id}
            className="row"
            style={{ ["--cc" as string]: categoryColor(categories, s.category), animationDelay: `${Math.min(i, 14) * 28}ms` }}
            onClick={() => onOpen(s.id)}
            onKeyDown={(e) => { if (e.key === "Enter") onOpen(s.id); }}
            tabIndex={0}
            role="button"
            aria-label={`Відкрити: ${s.name}`}
          >
            <span className="cb" />
            <div style={{ minWidth: 0 }}>
              <div className="nm">{s.name}</div>
              <div className="nt">{s.note.split("\n")[0] || s.category}</div>
            </div>
            {archive ? (
              <div className="nt">{s.category}</div>
            ) : (
              <div className="route">
                <div className="cur">
                  {st?.name ?? "Етап не задано"}
                  <small>· {done}/{s.steps.length}</small>
                </div>
                <div className="rail">
                  {s.steps.map((x, j) => (
                    <span key={x.id} style={{ display: "contents" }}>
                      {j > 0 && <s className={x.state === "done" || (s.steps[j - 1]!.state === "done" && x.state !== "pending") ? "done" : ""} />}
                      <i className={x.state} data-l={`${x.name}${x.actual ? ` · ${shortDate(x.actual)}` : x.plan ? ` · ${shortDate(x.plan)}` : ""}`} />
                    </span>
                  ))}
                </div>
              </div>
            )}
            {archive ? (
              <div className="nt">Оновлено {shortDate(s.updatedAt.slice(0, 10))}</div>
            ) : (
              <div className="when">
                <span className="d" style={dl.kind === "none" ? { color: "var(--faint)" } : undefined}>{dl.kind === "none" ? "—" : shortDate(dl.date)}</span>
                <span className={`badge2 ${BADGE[dl.kind]}`}>{deadlineLabel(dl)}</span>
              </div>
            )}
            <div className="next">
              {archive ? (
                editing && onRestore ? (
                  <button className="qb" onClick={(e) => { e.stopPropagation(); onRestore(s); }}>Відновити</button>
                ) : null
              ) : s.action ? (
                <span className="a"><IFlag />{s.action}</span>
              ) : (
                <span className="none">Дій не потрібно</span>
              )}
            </div>
            <span className="chev"><IChev /></span>
            {!archive && editing && st?.state === "active" && onComplete && (
              <div className="quick">
                <button className="qb okb" onClick={(e) => { e.stopPropagation(); onComplete(s); }}>
                  <ICheck />
                  {st.name} виконано
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
