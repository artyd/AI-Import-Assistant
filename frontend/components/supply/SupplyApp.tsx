"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SupplyApiError, setSupplyToken } from "@/lib/supply/api";
import { MONTHS_GEN, WEEKDAYS, completeActiveStep, deadline, kyivToday, type SortKey } from "@/lib/supply/logic";
import type { ShipmentDraft, SupplyShipment } from "@/lib/supply/types";
import { useSupply } from "@/lib/supply/useSupply";
import { CalendarView } from "./CalendarView";
import { DictView } from "./DictView";
import { HistoryView } from "./HistoryView";
import { ListView } from "./ListView";
import { Palette } from "./Palette";
import { PinModal } from "./PinModal";
import { ShipmentDrawer } from "./ShipmentDrawer";
import { IArch, ICal, IDl, IExit, IHist, IList, ILock, IPlus, ISearch, ISet, IUnlock, IX } from "./SupplyIcons";

export type View = "list" | "cal" | "arch" | "hist" | "dict";
export type ToastFn = (text: string, undo?: () => Promise<void> | void) => void;

const TITLES: Record<View, string> = { list: "Поставки", cal: "Календар", arch: "Архів", hist: "Історія змін", dict: "Довідники" };

export function SupplyApp() {
  const store = useSupply();
  const { data, editing } = store;
  const [view, setView] = useState<View>("list");
  const [cat, setCat] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("date");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<{ id: number; text: string; undo?: () => Promise<void> | void } | null>(null);
  const [today, setToday] = useState(() => kyivToday());

  useEffect(() => {
    const t = setInterval(() => setToday(kyivToday()), 60_000);
    return () => clearInterval(t);
  }, []);

  const showToast: ToastFn = useCallback((text, undo) => setToast({ id: Date.now(), text, undo }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo ? 6000 : 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof SupplyApiError && e.status === 409 && e.code === "conflict") showToast("Цю поставку щойно змінив хтось інший. Показую актуальну версію.");
      else if (e instanceof SupplyApiError && e.status === 401) showToast("Режим редагування завершився. Введіть код ще раз.");
      else showToast("Не вдалося зберегти. Спробуйте ще раз.");
      void store.reload();
    },
    [showToast, store],
  );

  const shipments = useMemo(() => data?.shipments ?? [], [data]);
  const live = useMemo(() => shipments.filter((s) => !s.archived), [shipments]);
  const categories = data?.settings.categories ?? [];
  const overdue = useMemo(() => live.filter((s) => deadline(s, today).kind === "overdue").length, [live, today]);
  const open = openId ? shipments.find((s) => s.id === openId) ?? null : null;

  const requestEdit = useCallback(async () => {
    if (editing) {
      store.lock();
      showToast("Повернулись у перегляд");
      return;
    }
    const r = await store.unlock().catch(() => "need_code" as const);
    if (r === "ok") showToast("Режим редагування увімкнено");
    else setPinOpen(true);
  }, [editing, showToast, store]);

  const completeStep = useCallback(
    async (s: SupplyShipment) => {
      const st = s.steps.find((x) => x.state === "active");
      if (!st) return;
      try {
        const next = completeActiveStep(s.steps, today);
        await store.update(s, { steps: next });
        const nx = next.find((x) => x.state === "active");
        showToast(nx ? `«${st.name}» виконано. Далі: ${nx.name}` : `«${st.name}» виконано. Усі етапи пройдено`, () => store.undoLast(s.id));
      } catch (e) {
        fail(e);
      }
    },
    [fail, showToast, store, today],
  );

  const reschedule = useCallback(
    async (s: SupplyShipment, index: number, day: string) => {
      const st = s.steps[index];
      if (!st || st.plan === day) return;
      try {
        await store.update(s, { steps: s.steps.map((x, i) => (i === index ? { ...x, plan: day } : x)) });
        showToast(`План «${st.name}» перенесено на ${day.slice(8, 10)}.${day.slice(5, 7)}`, () => store.undoLast(s.id));
      } catch (e) {
        fail(e);
      }
    },
    [fail, showToast, store],
  );

  const saveDraft = useCallback(
    async (s: SupplyShipment | null, draft: ShipmentDraft) => {
      try {
        if (s) {
          const saved = await store.update(s, draft);
          showToast("Збережено", () => store.undoLast(saved.id));
        } else {
          const created = await store.create(draft);
          setCreating(false);
          setOpenId(created.id);
          showToast(`Додано: ${created.name}`, () => store.undoLast(created.id));
        }
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [fail, showToast, store],
  );

  const setArchived = useCallback(
    async (s: SupplyShipment, archived: boolean) => {
      try {
        await store.archive(s, archived);
        setOpenId(null);
        showToast(archived ? "Перенесено в архів" : "Відновлено з архіву", () => store.undoLast(s.id));
      } catch (e) {
        fail(e);
      }
    },
    [fail, showToast, store],
  );

  // Ctrl/⌘ K opens search; Esc closes the top-most layer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === "Escape") {
        if (paletteOpen || pinOpen) return;
        setOpenId(null);
        setCreating(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, pinOpen]);

  const d = new Date(`${today}T12:00:00Z`);
  const dateLine = `${WEEKDAYS[d.getUTCDay()]!.charAt(0).toUpperCase()}${WEEKDAYS[d.getUTCDay()]!.slice(1)}, ${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}`;
  const visible = cat === "all" ? live : live.filter((s) => s.category === cat);

  return (
    <div className={`sp${view === "cal" ? " fixed" : ""}`}>
      <div className="shell">
        <nav className="side" aria-label="Розділи">
          <span className="logo" aria-hidden="true">П</span>
          {(
            [
              ["list", "Реєстр", <IList key="i" />],
              ["cal", "Календар", <ICal key="i" />],
              ["arch", "Архів", <IArch key="i" />],
              ["hist", "Історія", <IHist key="i" />],
              ["dict", "Довідники", <ISet key="i" />],
            ] as const
          ).map(([v, label, icon]) => (
            <button key={v} className="nb" aria-current={view === v} title={label} onClick={() => { setView(v); setOpenId(null); }}>
              {icon}
              {label}
              {v === "cal" && overdue > 0 && <span className="badge">{overdue}</span>}
            </button>
          ))}
          <span className="grow" />
          {/* Out to the site entry (Поставки ↔ Штурман); leaving also ends edit mode. */}
          <a className="nb" href="/" title="Вийти на головну" aria-label="Вийти з Поставок" onClick={() => setSupplyToken(null)}>
            <IExit />
            Вихід
          </a>
          <button className={`lockbtn${editing ? " on" : ""}`} onClick={requestEdit} title={editing ? "Вийти з редагування" : "Редагування за кодом Штурмана"} aria-label={editing ? "Вийти з редагування" : "Увімкнути редагування"}>
            {editing ? <IUnlock /> : <ILock />}
          </button>
        </nav>

        <main className="main">
          <header className="top">
            <div className="title">
              <h1>{TITLES[view]}</h1>
              <p>
                <span className="live"><i />Оновлюється автоматично</span>· {dateLine}
              </p>
            </div>
            <button className="cmd" onClick={() => setPaletteOpen(true)}>
              <ISearch />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>Знайти поставку</span>
              <kbd>Ctrl K</kbd>
            </button>
            <a className="ghost" style={{ height: 40, textDecoration: "none", color: "inherit" }} href="/api/supply/export.xlsx" download aria-label="Експорт у Excel">
              <IDl />
              <span className="hide-s">Excel</span>
            </a>
            <button className="btn" aria-label="Нова поставка" disabled={!editing} title={editing ? "" : "Потрібен код Штурмана"} onClick={() => { setOpenId(null); setCreating(true); }}>
              <IPlus />
              <span className="hide-s">Нова поставка</span>
            </button>
          </header>

          <div>
            {editing && (
              <div className="editbar">
                <span><IUnlock size={16} />Режим редагування. Кожна зміна йде в історію і відкочується.</span>
                <button className="ghost" onClick={requestEdit}>Завершити</button>
              </div>
            )}
          </div>

          {(view === "list" || view === "cal") && data ? (
            <Toolbar categories={categories} counts={live} cat={cat} setCat={setCat} sort={view === "list" ? sort : null} setSort={setSort} />
          ) : (
            <div />
          )}

          <section className="view">
            {!data ? (
              <div className="empty">
                {store.error ? (
                  <>
                    <b>Реєстр недоступний</b>
                    {store.error}
                    <button className="ghost" onClick={() => void store.reload()}>Спробувати ще раз</button>
                  </>
                ) : (
                  <b>Завантажуємо реєстр…</b>
                )}
              </div>
            ) : view === "list" ? (
              <ListView list={visible} categories={categories} sort={sort} today={today} editing={editing} onOpen={setOpenId} onComplete={completeStep} />
            ) : view === "cal" ? (
              <CalendarView list={visible} categories={categories} today={today} editing={editing} onOpen={setOpenId} onReschedule={reschedule} />
            ) : view === "arch" ? (
              <ListView list={shipments.filter((s) => s.archived)} categories={categories} sort="updated" today={today} editing={editing} onOpen={setOpenId} archive
                onRestore={(s) => void setArchived(s, false)} />
            ) : view === "hist" ? (
              <HistoryView revision={data.revision} editing={editing} onUndo={async (id) => { try { await store.undo(id); showToast("Зміну відкочено"); } catch (e) { fail(e); } }} />
            ) : (
              <DictView settings={data.settings} editing={editing} onSave={async (s) => { try { await store.saveSettings(s); showToast("Довідники збережено", () => store.undoLast(null)); return true; } catch (e) { fail(e); return false; } }} />
            )}
          </section>
        </main>
      </div>

      {data && (
        <ShipmentDrawer
          key={creating ? "new" : open?.id ?? "none"}
          open={creating || !!open}
          shipment={creating ? null : open}
          settings={data.settings}
          defaultCategory={cat !== "all" ? cat : categories[0] ?? ""}
          editing={editing}
          today={today}
          onClose={() => { setOpenId(null); setCreating(false); }}
          onSave={saveDraft}
          onArchive={setArchived}
          onComplete={completeStep}
          onUnlock={requestEdit}
        />
      )}

      {pinOpen && (
        <PinModal
          length={store.codeLength ?? 6}
          enabled={store.codeLogin}
          onCancel={() => setPinOpen(false)}
          onSubmit={async (code) => {
            await store.unlock(code);
            setPinOpen(false);
            showToast("Режим редагування увімкнено");
          }}
        />
      )}

      {paletteOpen && data && (
        <Palette shipments={shipments} categories={categories} today={today} onClose={() => setPaletteOpen(false)} onPick={(id) => { setPaletteOpen(false); setCreating(false); setOpenId(id); }} />
      )}

      {toast && (
        <div className="toast" key={toast.id} role="status">
          <span>{toast.text}</span>
          {toast.undo && editing && (
            <button onClick={async () => { const u = toast.undo!; setToast(null); try { await u(); showToast("Скасовано"); } catch (e) { fail(e); } }}>Скасувати</button>
          )}
          <button aria-label="Закрити" onClick={() => setToast(null)} style={{ background: "transparent", padding: 4 }}><IX size={13} /></button>
        </div>
      )}
    </div>
  );
}

function Toolbar({
  categories, counts, cat, setCat, sort, setSort,
}: {
  categories: string[];
  counts: SupplyShipment[];
  cat: string;
  setCat: (c: string) => void;
  sort: SortKey | null;
  setSort: (s: SortKey) => void;
}) {
  const seg = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  const items: [string, string, number][] = [["all", "Усі", counts.length], ...categories.map((c) => [c, c, counts.filter((s) => s.category === c).length] as [string, string, number])];

  useLayoutEffect(() => {
    const measure = () => {
      const on = seg.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (on) setInd({ left: on.offsetLeft, width: on.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [cat, categories.length, counts.length]);

  return (
    <div className="toolbar">
      <div className="segc" ref={seg}>
        {ind && <span className="ind" style={{ left: ind.left, width: ind.width }} />}
        {items.map(([k, label, n], i) => (
          <button key={k} aria-pressed={cat === k} onClick={() => setCat(k)}>
            {k !== "all" && <i style={{ background: `var(--c-${(i - 1) % 5 + 1})` }} />}
            {label}
            <b className="tn">{n}</b>
          </button>
        ))}
      </div>
      <span className="sp-gap" style={{ flex: 1 }} />
      {sort && (
        <select className="sort" aria-label="Сортування" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="date">За датою</option>
          <option value="name">За назвою</option>
          <option value="updated">Нещодавно змінені</option>
        </select>
      )}
    </div>
  );
}
