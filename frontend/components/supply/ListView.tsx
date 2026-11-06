"use client";

import { categoryColor, categoryIcon, currentStep, deadline, deadlineLabel, shortDate, sortShipments, transportMode, MODES, type SortKey } from "@/lib/supply/logic";
import type { SupplySettings, SupplyShipment } from "@/lib/supply/types";
import { CategoryIcon, GroupIcon, ModeIcon, StarMark } from "./KindIcon";
import { IArch, ICheck, IChev, IFlag } from "./SupplyIcons";

const BADGE: Record<string, string> = { overdue: "b-over", soon: "b-soon", later: "b-later", none: "b-none", done: "b-ok" };

/** Deadline groups shown as headers when the list is sorted by date. */
const GROUPS = [
  { key: "pinned", label: "Обрані", color: "var(--star)" },
  { key: "overdue", label: "Прострочено", color: "var(--err)" },
  { key: "near", label: "Найближчі дні", color: "var(--warn)" },
  { key: "week", label: "Цього тижня", color: "var(--accent)" },
  { key: "later", label: "Пізніше", color: "var(--faint)" },
  { key: "none", label: "Без дати", color: "var(--faint)" },
  { key: "done", label: "Етап виконано", color: "var(--ok)" },
] as const;
function groupOf(s: SupplyShipment, today: string): (typeof GROUPS)[number]["key"] {
  if (s.pinned) return "pinned";
  const d = deadline(s, today);
  if (d.kind === "overdue" || d.kind === "none" || d.kind === "done" || d.kind === "later") return d.kind;
  return (d.days ?? 0) <= 2 ? "near" : "week";
}

export function ListView({
  list, settings, sort, today, editing, onOpen, onComplete, onStar, archive, onRestore,
}: {
  list: SupplyShipment[];
  settings: SupplySettings;
  sort: SortKey;
  today: string;
  editing: boolean;
  onOpen: (id: string) => void;
  onComplete?: (s: SupplyShipment) => void;
  onStar?: (s: SupplyShipment) => void;
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

  const categories = settings.categories;
  const groupName = new Map(settings.groups.map((g) => [g.id, g.name]));
  const sorted = sortShipments(list, sort, today);
  const grouped = sort === "date" && !archive;
  const counts = new Map<string, number>();
  if (grouped) for (const s of sorted) counts.set(groupOf(s, today), (counts.get(groupOf(s, today)) ?? 0) + 1);
  let last = "";

  return (
    <div className="list">
      {sorted.map((s, i) => {
        const g = grouped ? groupOf(s, today) : "";
        const head = grouped && g !== last ? GROUPS.find((x) => x.key === g) : null;
        last = g;
        const st = currentStep(s.steps);
        const dl = deadline(s, today);
        const done = s.steps.filter((x) => x.state === "done").length;
        const mode = transportMode(s);
        return (
          <div key={s.id} style={{ display: "contents" }}>
          {head && (
            <div className="grp" style={{ ["--gc" as string]: head.color }}>
              <i />
              {head.label}
              <b className="tn">{counts.get(head.key)}</b>
            </div>
          )}
          <article
            className="row"
            style={{ ["--cc" as string]: categoryColor(categories, s.category), animationDelay: `${Math.min(i, 14) * 28}ms` }}
            onClick={() => onOpen(s.id)}
            onKeyDown={(e) => { if (e.key === "Enter") onOpen(s.id); }}
            tabIndex={0}
            role="button"
            aria-label={`Відкрити: ${s.name}`}
          >
            <span className="cb" />
            <div className="nmw">
              <span className="kind" title={s.category} aria-label={s.category}>
                <CategoryIcon icon={categoryIcon(settings, s.category)} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="nm">
                  {s.name}
                  {onStar && editing && !archive ? (
                    <button className={`star${s.pinned ? " on" : ""}`} aria-pressed={s.pinned} aria-label={s.pinned ? "Прибрати з обраних" : "Додати в обрані"}
                      title={s.pinned ? "Прибрати з обраних" : "В обрані (завжди вгорі)"} onClick={(e) => { e.stopPropagation(); onStar(s); }}>
                      <StarMark on={s.pinned} />
                    </button>
                  ) : s.pinned ? (
                    <span className="star on" title="Обрана"><StarMark on /></span>
                  ) : null}
                </div>
                <div className="nt">
                  {mode && <span className="mode" title={MODES.find((m) => m.key === mode)?.label}><ModeIcon mode={mode} size={13} /></span>}
                  {s.groups.filter((g) => groupName.has(g)).map((g) => (
                    <span key={g} className="gtag"><GroupIcon size={11} />{groupName.get(g)}</span>
                  ))}
                  {s.note.split("\n")[0] || s.category}
                </div>
              </div>
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
                <span className="none" aria-label="Дій не потрібно">—</span>
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
          </div>
        );
      })}
    </div>
  );
}
