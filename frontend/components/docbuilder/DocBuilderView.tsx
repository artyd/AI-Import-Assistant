"use client";

// Конструктор документів (spec 012): logists assemble a contract + specification,
// an annex to a contract, an invoice + packing list or a Ukrainian накладна /
// рахунок from the team directory, watch the real Word document take shape on
// the right, check it, move it draft → checked → sent, and download Word / PDF /
// a ZIP of everything that belongs together.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/lib/docbuilder/api";
import type {
  AppendixData,
  ContractData,
  DirectoryParty,
  DirectoryProduct,
  DocData,
  DocEvent,
  DocFull,
  DocKind,
  DocStatus,
  DocSummary,
  Finding,
  InvoiceData,
  Party,
  Product,
  TemplateInfo,
  UaInvoiceData,
} from "@/lib/docbuilder/model";
import {
  KIND_LABEL,
  KIND_SUBTITLE,
  STATUS_LABEL,
  contractNumber,
  docCurrency,
  docTotal,
  emptyContract,
  emptyInvoice,
  emptyUaInvoice,
  eventLabel,
  fmtMoney,
  gapsFor,
  snapshot,
  todayIso,
} from "@/lib/docbuilder/model";
import { ContractForm } from "./ContractForm";
import { AppendixForm } from "./AppendixForm";
import { InvoiceForm } from "./InvoiceForm";
import { UaInvoiceForm } from "./UaInvoiceForm";
import { DirectoryPanel } from "./DirectoryPanel";
import { smallBtn } from "./fields";

type SaveState = "idle" | "saving" | "saved" | "error";
type Filter = "all" | DocKind;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Усі" },
  { value: "contract", label: "Контракти" },
  { value: "appendix", label: "Додатки" },
  { value: "invoice", label: "Інвойси" },
  { value: "ua_invoice", label: "Накладні" },
];

const STATUS_COLOR: Record<DocStatus, string> = { draft: "var(--muted)", checked: "var(--info)", sent: "var(--ok)" };

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function StatusPill({ status }: { status: DocStatus }) {
  return (
    <span
      data-testid="docb-status"
      style={{
        fontSize: 10.5,
        fontWeight: 800,
        letterSpacing: 0.3,
        padding: "1px 7px",
        borderRadius: 999,
        color: STATUS_COLOR[status],
        border: `1px solid ${STATUS_COLOR[status]}`,
        whiteSpace: "nowrap",
      }}
    >
      {STATUS_LABEL[status].toUpperCase()}
    </span>
  );
}

/** A small click-to-open menu (no portal; closes on outside click). */
function Menu({ label, children, testId, primary }: { label: React.ReactNode; children: (close: () => void) => React.ReactNode; testId?: string; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className={primary ? "btn btn-primary" : undefined}
        style={primary ? { height: 34, fontSize: 13, padding: "0 10px", borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "1px solid rgba(255,255,255,.35)" } : { ...smallBtn, height: 34 }}
        onClick={() => setOpen((o) => !o)}
        data-testid={testId}
        aria-expanded={open}
      >
        {label}
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: 38,
            zIndex: 30,
            minWidth: 240,
            background: "var(--menu)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "var(--shadow)",
            padding: 6,
            display: "grid",
            gap: 2,
          }}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

const menuItem: React.CSSProperties = {
  textAlign: "left",
  border: "none",
  background: "transparent",
  borderRadius: 8,
  padding: "8px 10px",
  cursor: "pointer",
  color: "var(--text)",
  font: "inherit",
  fontSize: 13,
};

/** Pick one of the user's Штурман shipments. */
function ShipmentPicker({
  title,
  hint,
  onPick,
  onClose,
  actions,
}: {
  title: string;
  hint: string;
  onPick: (id: string, action: string) => void;
  onClose: () => void;
  actions: { value: string; label: string }[];
}) {
  const [list, setList] = useState<api.ShipmentOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState(actions[0]?.value ?? "");
  const [q, setQ] = useState("");
  useEffect(() => {
    api.listShipments().then(setList).catch((e: Error) => setError(e.message || "Не вдалося завантажити постачання"));
  }, []);
  const hits = (list ?? []).filter((w) => `${w.number ?? ""} ${w.supplier ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div data-testid="docb-shipment-picker" style={{ margin: "10px 16px 0", padding: 12, border: "1px solid var(--accent)", borderRadius: "var(--radius)", background: "var(--surface)", display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <b style={{ fontSize: 14 }}>{title}</b>
        <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{hint}</span>
        <button type="button" style={{ ...smallBtn, marginLeft: "auto" }} onClick={onClose}>
          Закрити
        </button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {actions.length > 1 ? (
          <select className="input" style={{ height: 32, fontSize: 13 }} value={action} onChange={(e) => setAction(e.target.value)} data-testid="docb-shipment-action">
            {actions.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        ) : null}
        <input className="input" style={{ flex: 1, height: 32, fontSize: 13, padding: "0 10px" }} placeholder="Пошук за номером чи постачальником" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error ? <div style={{ color: "var(--err)", fontSize: 13 }}>{error}</div> : null}
      <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gap: 2 }}>
        {list === null ? <span style={{ fontSize: 13, color: "var(--muted)" }}>Завантажую…</span> : null}
        {list && hits.length === 0 ? <span style={{ fontSize: 13, color: "var(--muted)" }}>Постачань не знайдено.</span> : null}
        {hits.map((w) => (
          <button key={w.id} type="button" className="nav-row" style={menuItem} onClick={() => onPick(w.id, action)} data-testid="docb-shipment-option">
            №{w.number ?? "—"} {w.supplier ? `· ${w.supplier}` : ""}
          </button>
        ))}
      </div>
    </div>
  );
}

const shortTitle = (d: { kind: DocKind; title: string; number: string }) => (d.kind === "appendix" ? d.title.split(" · ")[0] : d.number || "без номера");

export function DocBuilderView() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [parties, setParties] = useState<DirectoryParty[]>([]);
  const [products, setProducts] = useState<DirectoryProduct[]>([]);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [mode, setMode] = useState<"doc" | "directory">("doc");
  const [current, setCurrent] = useState<DocFull | null>(null);
  const [data, setData] = useState<DocData | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [preview, setPreview] = useState<{ html: string; loading: boolean; error: string | null }>({ html: "", loading: false, error: null });
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [events, setEvents] = useState<DocEvent[] | null>(null);
  const [picker, setPicker] = useState<"from" | "to" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = useRef(false);

  const refreshDocs = useCallback(() => api.listDocuments().then(setDocs).catch(() => undefined), []);

  useEffect(() => {
    Promise.all([api.listDocuments(), api.listParties(), api.listProducts(), api.listTemplates().catch(() => [] as TemplateInfo[])])
      .then(([d, p, pr, t]) => {
        setDocs(d);
        setParties(p);
        setProducts(pr);
        setTemplates(t);
        if (p.length === 0) setMode("directory");
      })
      .catch((e: Error) => setError(e.message || "Не вдалося завантажити конструктор"));
  }, []);

  const open = useCallback(async (id: string) => {
    setError(null);
    setFindings(null);
    setEvents(null);
    setConfirmDelete(false);
    try {
      const d = await api.getDocument(id);
      dirty.current = false;
      setCurrent(d);
      setData(d.data);
      setSaveState("saved");
      setMode("doc");
    } catch (e) {
      setError((e as Error).message || "Документ не відкрився");
    }
  }, []);

  const sellerDir = parties.find((p) => p.role === "seller") ?? null;
  const seller = sellerDir ? snapshot(sellerDir) : null;

  const create = async (kind: DocKind, initial?: DocData, contractId?: string | null, workspaceId?: string | null) => {
    setError(null);
    setInfo(null);
    try {
      const base: DocData =
        initial ??
        (kind === "contract" ? emptyContract(seller) : kind === "ua_invoice" ? emptyUaInvoice(null) : { ...emptyInvoice(seller), templateId: sellerDir?.invoiceTemplateId ?? null });
      if (!initial && kind === "invoice") (base as InvoiceData).number = await api.nextNumber("invoice").catch(() => "");
      if (!initial && kind === "ua_invoice") (base as UaInvoiceData).number = await api.nextNumber("ua_invoice").catch(() => "");
      const d = await api.createDocument(kind, base, contractId, workspaceId);
      await refreshDocs();
      await open(d.id);
    } catch (e) {
      setError((e as Error).message || "Не вдалося створити документ");
    }
  };

  const locked = current ? current.status !== "draft" : false;

  // ---- autosave (debounced) ----
  useEffect(() => {
    if (!current || !data || !dirty.current || locked) return;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try {
        const saved = await api.saveDocument(current.id, data);
        dirty.current = false;
        setSaveState("saved");
        setDocs((list) => list.map((x) => (x.id === saved.id ? { ...x, number: saved.number, title: saved.title, date: data.date, total: docTotal(current.kind, data), updatedAt: saved.updatedAt } : x)));
      } catch {
        setSaveState("error");
      }
    }, 800);
    return () => clearTimeout(t);
  }, [data, current, locked]);

  // ---- live preview (debounced) ----
  useEffect(() => {
    if (!current || !data) return;
    const ctrl = new AbortController();
    setPreview((p) => ({ ...p, loading: true }));
    const t = setTimeout(() => {
      api
        .previewHtml(current.kind, data, ctrl.signal)
        .then((r) => setPreview({ html: r.html, loading: false, error: null }))
        .catch((e: Error) => {
          if (e.name !== "AbortError") setPreview((p) => ({ ...p, loading: false, error: e.message || "Перегляд недоступний" }));
        });
    }, 450);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [data, current]);

  const edit = (d: DocData) => {
    if (locked) return;
    dirty.current = true;
    setFindings(null);
    setData(d);
  };

  // ---- directory callbacks ----
  const saveParty = async (p: DirectoryParty | Omit<DirectoryParty, "id">) => {
    const saved = "id" in p ? await api.updateParty(p) : await api.createParty(p);
    setParties((list) => [...list.filter((x) => x.id !== saved.id), saved].sort((a, b) => a.role.localeCompare(b.role) || (a.nameEn || a.nameUk).localeCompare(b.nameEn || b.nameUk)));
  };
  const savePartyFromDoc = (p: Party, role: DirectoryParty["role"]) => saveParty({ ...p, role, note: "" });
  const saveProduct = async (p: DirectoryProduct | Product) => {
    const clean: Product = { nameEn: p.nameEn, nameUk: p.nameUk, hs: p.hs, reg: p.reg, manufacturer: p.manufacturer, countryEn: p.countryEn, countryUk: p.countryUk, unit: p.unit ?? "kg" };
    const saved = "id" in p ? await api.updateProduct({ ...clean, id: p.id }) : await api.createProduct(clean);
    setProducts((list) => [...list.filter((x) => x.id !== saved.id), saved].sort((a, b) => (a.nameEn || a.nameUk).localeCompare(b.nameEn || b.nameUk)));
  };

  const gaps = useMemo(() => (current && data ? gapsFor(current.kind, data) : []), [current, data]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return docs.filter((d) => (filter === "all" || d.kind === filter) && (!s || `${d.number} ${d.title}`.toLowerCase().includes(s)));
  }, [docs, q, filter]);

  const byId = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message || "Не вдалося виконати дію");
    } finally {
      setBusy(null);
    }
  };

  /** Save pending edits right away (before an action that reads the saved document). */
  const flush = async () => {
    if (current && data && dirty.current && current.status === "draft") {
      await api.saveDocument(current.id, data);
      dirty.current = false;
    }
  };

  const openNew = async (p: Promise<DocFull>) => {
    await flush();
    const d = await p;
    await refreshDocs();
    await open(d.id);
  };

  const changeStatus = (status: DocStatus) =>
    run("status", async () => {
      if (!current) return;
      await flush();
      const d = await api.setStatus(current.id, status);
      setCurrent(d);
      await refreshDocs();
      if (events) setEvents(await api.listEvents(d.id));
    });

  const check = () =>
    run("check", async () => {
      if (!current || !data) return;
      setFindings(await api.checkDocument(current.kind, data, current.id, current.contractId));
    });

  const duplicate = () => {
    if (!current || !data) return;
    const today = todayIso();
    let copy: DocData;
    if (current.kind === "contract") copy = { ...(data as ContractData), date: today, number: contractNumber(today, (data as ContractData).buyer.code) };
    else if (current.kind === "appendix") copy = { ...(data as AppendixData), date: today, number: "" };
    else copy = { ...(data as InvoiceData), date: today, number: "" };
    void create(current.kind, copy, current.contractId);
  };

  const remove = () =>
    run("delete", async () => {
      if (!current) return;
      await api.deleteDocument(current.id);
      setCurrent(null);
      setData(null);
      setConfirmDelete(false);
      await refreshDocs();
    });

  const listRow = (d: DocSummary) => {
    const active = current?.id === d.id && mode === "doc";
    const parent = d.contractId ? byId.get(d.contractId) : undefined;
    const badge: Record<DocKind, { text: string; color: string }> = {
      contract: { text: "КОНТРАКТ", color: "var(--accent)" },
      appendix: { text: "ДОДАТОК", color: "#8b5cf6" },
      invoice: { text: "ІНВОЙС", color: "var(--ok)" },
      ua_invoice: { text: "НАКЛАДНА", color: "var(--warn)" },
    };
    const b = badge[d.kind];
    return (
      <button
        key={d.id}
        type="button"
        className="nav-row"
        data-testid="docb-doc-row"
        onClick={() => open(d.id)}
        style={{ textAlign: "left", width: "100%", border: "none", borderRadius: 10, padding: "8px 10px", cursor: "pointer", background: active ? "var(--active)" : "transparent", color: "var(--text)", font: "inherit" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, padding: "1px 6px", borderRadius: 6, background: `color-mix(in srgb, ${b.color} 15%, transparent)`, color: b.color }}>{b.text}</span>
          <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{shortTitle(d)}</span>
          {d.status !== "draft" ? <span style={{ width: 8, height: 8, borderRadius: 99, background: STATUS_COLOR[d.status], flex: "none" }} title={STATUS_LABEL[d.status]} /> : null}
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{d.title.split(" · ").slice(1).join(" · ") || "—"}</div>
        <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 1 }}>
          {[fmtDate(d.date), d.total ? `${fmtMoney(d.total)} ${d.kind === "ua_invoice" || d.currency === "UAH" ? "грн" : d.currency}` : "", d.version > 1 ? `в.${d.version}` : "", parent ? `до ${shortTitle(parent)}` : ""].filter(Boolean).join(" · ")}
        </div>
      </button>
    );
  };

  const parentDoc = current?.contractId ? byId.get(current.contractId) : undefined;

  return (
    <div data-testid="docb-view" style={{ height: "100%", display: "flex", minHeight: 0, background: "var(--bg)" }}>
      {/* ---------- list ---------- */}
      <aside style={{ width: 272, flex: "none", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--panel)" }}>
        <div style={{ padding: "14px 12px 8px", display: "grid", gap: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button type="button" className="btn btn-primary" style={{ height: 34, fontSize: 13 }} onClick={() => create("contract")} data-testid="docb-new-contract">
              ＋ Контракт
            </button>
            <button type="button" className="btn" style={{ height: 34, fontSize: 13 }} onClick={() => create("invoice")} data-testid="docb-new-invoice">
              ＋ Інвойс
            </button>
            <button type="button" className="btn" style={{ height: 34, fontSize: 13 }} onClick={() => create("ua_invoice")} data-testid="docb-new-ua">
              ＋ Накладна
            </button>
            <button type="button" className="btn" style={{ height: 34, fontSize: 13 }} onClick={() => setPicker(picker === "from" ? null : "from")} data-testid="docb-from-shipment">
              З постачання
            </button>
          </div>
          <input className="input" style={{ height: 32, fontSize: 13, padding: "0 10px" }} placeholder="Пошук за номером чи компанією" value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                data-testid={`docb-filter-${f.value}`}
                style={{ ...smallBtn, height: 24, fontSize: 11.5, padding: "0 8px", borderColor: filter === f.value ? "var(--accent)" : "var(--border)", background: filter === f.value ? "var(--active)" : "var(--surface)" }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 6px 8px" }}>
          {filtered.length === 0 ? <p style={{ fontSize: 12.5, color: "var(--muted)", padding: "8px 8px" }}>{docs.length ? "Нічого не знайдено." : "Ще немає документів. Створіть перший контракт."}</p> : filtered.map(listRow)}
        </div>
        <div style={{ borderTop: "1px solid var(--border)", padding: 8 }}>
          <button
            type="button"
            className="nav-row"
            onClick={() => setMode("directory")}
            data-testid="docb-open-directory"
            style={{ width: "100%", textAlign: "left", border: "none", borderRadius: 10, padding: "9px 10px", cursor: "pointer", background: mode === "directory" ? "var(--active)" : "transparent", color: "var(--text)", font: "inherit", fontSize: 13.5, fontWeight: 600 }}
          >
            Довідник · {parties.length} компаній · {products.length} товарів
          </button>
        </div>
      </aside>

      {/* ---------- editor ---------- */}
      <main style={{ flex: "1.2 1 0", minWidth: 480, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {error ? (
          <div role="alert" style={{ margin: "10px 16px 0", padding: "8px 12px", borderRadius: 10, background: "color-mix(in srgb, var(--err) 12%, transparent)", color: "var(--err)", fontSize: 13 }}>
            {error}
          </div>
        ) : null}
        {info ? (
          <div role="status" data-testid="docb-info" style={{ margin: "10px 16px 0", padding: "8px 12px", borderRadius: 10, background: "color-mix(in srgb, var(--ok) 12%, transparent)", fontSize: 13, display: "flex", gap: 8 }}>
            <span style={{ flex: 1 }}>{info}</span>
            <button type="button" style={{ ...smallBtn, height: 22 }} onClick={() => setInfo(null)}>
              ×
            </button>
          </div>
        ) : null}
        {picker === "from" ? (
          <ShipmentPicker
            title="Створити з постачання"
            hint="Сторони й товари з документів постачання — лише те, що в них написано."
            actions={[
              { value: "contract", label: "Контракт" },
              { value: "invoice", label: "Інвойс" },
            ]}
            onClose={() => setPicker(null)}
            onPick={(wid, action) =>
              run("from", async () => {
                const r = await api.fromShipment(wid);
                setPicker(null);
                if (action === "invoice") await create("invoice", { ...r.invoice, number: await api.nextNumber("invoice").catch(() => "") }, null, wid);
                else await create("contract", r.contract, null, wid);
                setInfo(r.sources.length ? `Заповнено з: ${r.sources.join(", ")}. Обовʼязково перевірте всі поля.` : "У постачанні ще немає прочитаних контракту чи інвойсу — створено порожню чернетку.");
              })
            }
          />
        ) : null}

        {mode === "directory" ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 4px" }}>Довідник</h2>
            <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 14px" }}>Компанії, товари та шаблони Word, з яких збираються документи. Спільні для всієї команди.</p>
            <DirectoryPanel
              parties={parties}
              products={products}
              onSaveParty={saveParty}
              onDeleteParty={async (id) => {
                await api.deleteParty(id);
                setParties((l) => l.filter((x) => x.id !== id));
              }}
              onSaveProduct={saveProduct}
              onDeleteProduct={async (id) => {
                await api.deleteProduct(id);
                setProducts((l) => l.filter((x) => x.id !== id));
              }}
              templates={templates}
              onTemplates={setTemplates}
            />
          </div>
        ) : current && data ? (
          <>
            <div style={{ flex: "none", padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, flex: "1 1 220px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} data-testid="docb-title">
                    {current.kind === "ua_invoice" ? ((data as UaInvoiceData).docType === "rahunok" ? "Рахунок" : "Накладна") : KIND_LABEL[current.kind]} {current.kind === "appendix" ? current.title.split(" · ")[0] : data.number ? `№ ${data.number}` : "без номера"}
                  </span>
                  <StatusPill status={current.status} />
                  {current.version > 1 ? <span style={{ fontSize: 11.5, color: "var(--muted)" }}>версія {current.version}</span> : null}
                </div>
                <div style={{ fontSize: 12, color: saveState === "error" ? "var(--err)" : "var(--muted)" }} data-testid="docb-save-state">
                  {locked ? "Редагування закрите" : saveState === "saving" ? "Зберігаю…" : saveState === "error" ? "Не збережено — перевірте зʼєднання" : "Збережено"} · {KIND_SUBTITLE[current.kind]}
                  {parentDoc ? ` · до ${shortTitle(parentDoc)}` : ""}
                </div>
              </div>
              <button type="button" style={{ ...smallBtn, height: 34 }} onClick={check} disabled={busy === "check"} data-testid="docb-check">
                {busy === "check" ? "Перевіряю…" : "Перевірити"}
              </button>
              {current.kind === "contract" ? (
                <>
                  <button type="button" style={{ ...smallBtn, height: 34 }} onClick={() => run("appendix", () => openNew(api.appendixFrom(current.id)))} data-testid="docb-make-appendix">
                    ＋ Додаток
                  </button>
                  <button type="button" style={{ ...smallBtn, height: 34 }} onClick={() => run("invoice", () => openNew(api.invoiceFrom(current.id)))} data-testid="docb-make-invoice">
                    Інвойс до контракту
                  </button>
                </>
              ) : null}
              {current.kind === "appendix" ? (
                <button type="button" style={{ ...smallBtn, height: 34 }} onClick={() => run("invoice", () => openNew(api.invoiceFrom(current.id)))} data-testid="docb-make-invoice">
                  Інвойс до додатку
                </button>
              ) : null}
              {current.status === "draft" ? (
                <button type="button" style={{ ...smallBtn, height: 34, color: "var(--info)" }} onClick={() => changeStatus("checked")} data-testid="docb-mark-checked">
                  ✓ Перевірено
                </button>
              ) : null}
              {current.status === "checked" ? (
                <>
                  <button type="button" style={{ ...smallBtn, height: 34 }} onClick={() => changeStatus("draft")} data-testid="docb-mark-draft">
                    В чернетку
                  </button>
                  <button type="button" style={{ ...smallBtn, height: 34, color: "var(--ok)" }} onClick={() => changeStatus("sent")} data-testid="docb-mark-sent">
                    Відправлено
                  </button>
                </>
              ) : null}
              {current.status === "sent" ? (
                <button type="button" style={{ ...smallBtn, height: 34 }} onClick={() => run("version", () => openNew(api.newVersion(current.id)))} data-testid="docb-new-version">
                  Нова версія
                </button>
              ) : null}
              <Menu label="Ще ▾" testId="docb-more">
                {(close) => (
                  <>
                    <button type="button" className="nav-row" style={menuItem} onClick={() => { close(); duplicate(); }} data-testid="docb-duplicate">
                      Дублювати
                    </button>
                    <button type="button" className="nav-row" style={menuItem} onClick={() => { close(); setPicker("to"); }} data-testid="docb-to-shipment">
                      Зберегти в постачання…
                    </button>
                    <button
                      type="button"
                      className="nav-row"
                      style={menuItem}
                      onClick={async () => {
                        close();
                        setEvents(events ? null : await api.listEvents(current.id).catch(() => []));
                      }}
                      data-testid="docb-history"
                    >
                      Історія змін
                    </button>
                    <button type="button" className="nav-row" style={{ ...menuItem, color: "var(--err)" }} onClick={() => { close(); setConfirmDelete(true); }} data-testid="docb-delete">
                      Видалити…
                    </button>
                  </>
                )}
              </Menu>
              <div style={{ display: "flex" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ height: 34, fontSize: 13, borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                  onClick={() => run("download", () => api.downloadDoc(current.kind, data, "docx"))}
                  disabled={busy === "download"}
                  data-testid="docb-download"
                  title="Перед завантаженням обовʼязково перевірте всі поля"
                >
                  {busy === "download" ? "Формую…" : "Завантажити Word"}
                </button>
                <Menu label="▾" testId="docb-download-more" primary>
                  {(close) => (
                    <>
                      <button type="button" className="nav-row" style={menuItem} onClick={() => { close(); void run("download", () => api.downloadDoc(current.kind, data, "pdf")); }} data-testid="docb-download-pdf">
                        PDF
                      </button>
                      <button type="button" className="nav-row" style={menuItem} onClick={() => { close(); void run("download", async () => { await flush(); await api.downloadBundle(current.id, false); }); }} data-testid="docb-download-zip">
                        Пакет ZIP з повʼязаними документами (Word)
                      </button>
                      <button type="button" className="nav-row" style={menuItem} onClick={() => { close(); void run("download", async () => { await flush(); await api.downloadBundle(current.id, true); }); }}>
                        Пакет ZIP (Word + PDF)
                      </button>
                    </>
                  )}
                </Menu>
              </div>
            </div>

            {confirmDelete ? (
              <div style={{ margin: "10px 16px 0", padding: "8px 12px", borderRadius: 10, background: "color-mix(in srgb, var(--err) 10%, transparent)", fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
                Видалити цей документ назавжди?
                <button type="button" style={{ ...smallBtn, color: "#fff", background: "var(--err)", borderColor: "var(--err)" }} onClick={remove} data-testid="docb-delete-confirm">
                  Так, видалити
                </button>
                <button type="button" style={smallBtn} onClick={() => setConfirmDelete(false)}>
                  Ні
                </button>
              </div>
            ) : null}

            {picker === "to" ? (
              <ShipmentPicker
                title="Зберегти в постачання"
                hint="Word-файл потрапить у файли постачання — Штурман прочитає його й звірить з іншими документами."
                actions={[{ value: "save", label: "Зберегти" }]}
                onClose={() => setPicker(null)}
                onPick={(wid) =>
                  run("to", async () => {
                    await flush();
                    const r = await api.toShipment(current.id, wid);
                    setPicker(null);
                    setInfo(r.duplicateOf ? `Такий самий файл уже є в постачанні: ${r.duplicateOf}.` : "Документ збережено у файли постачання — Штурман його прочитає і звірить.");
                  })
                }
              />
            ) : null}

            {locked ? (
              <div data-testid="docb-locked" style={{ flex: "none", margin: "10px 16px 0", padding: "8px 12px", borderRadius: 10, background: "color-mix(in srgb, var(--info) 10%, transparent)", fontSize: 12.5 }}>
                Документ {current.status === "sent" ? "відправлено" : "перевірено"} — редагування закрите.{" "}
                {current.status === "sent" ? "Щоб змінити, створіть нову версію (стара залишиться як була)." : "Щоб змінити, поверніть його в чернетку."}
              </div>
            ) : null}

            {findings ? (
              <div data-testid="docb-findings" style={{ flex: "none", margin: "10px 16px 0", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", fontSize: 12.5, maxHeight: 220, overflowY: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <b>Перевірка</b>
                  <span style={{ color: "var(--muted)" }}>
                    помилок {findings.filter((f) => f.level === "error").length} · попереджень {findings.filter((f) => f.level === "warning").length} · гаразд {findings.filter((f) => f.level === "ok").length}
                  </span>
                  <button type="button" style={{ ...smallBtn, marginLeft: "auto", height: 24 }} onClick={() => setFindings(null)}>
                    Сховати
                  </button>
                </div>
                {findings.length === 0 ? <div style={{ color: "var(--muted)" }}>Немає що перевіряти автоматично — перевірте поля вручну.</div> : null}
                {[...findings]
                  .sort((a, b) => ["error", "warning", "ok"].indexOf(a.level) - ["error", "warning", "ok"].indexOf(b.level))
                  .map((f, i) => (
                    <div key={i} data-testid={`docb-finding-${f.level}`} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
                      <span style={{ color: f.level === "error" ? "var(--err)" : f.level === "warning" ? "var(--warn)" : "var(--ok)", fontWeight: 800, width: 14 }}>{f.level === "error" ? "✕" : f.level === "warning" ? "!" : "✓"}</span>
                      <span>{f.message}</span>
                    </div>
                  ))}
              </div>
            ) : null}

            {events ? (
              <div data-testid="docb-events" style={{ flex: "none", margin: "10px 16px 0", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", fontSize: 12.5, maxHeight: 180, overflowY: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                  <b>Історія змін</b>
                  <button type="button" style={{ ...smallBtn, marginLeft: "auto", height: 24 }} onClick={() => setEvents(null)}>
                    Сховати
                  </button>
                </div>
                {events.length === 0 ? <div style={{ color: "var(--muted)" }}>Ще немає записів.</div> : null}
                {events.map((e, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, padding: "2px 0" }}>
                    <span style={{ color: "var(--muted)", width: 90, flex: "none" }}>{fmtDateTime(e.at)}</span>
                    <span style={{ width: 140, flex: "none", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.user || "Штурман"}</span>
                    <span>{eventLabel(e)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {gaps.length && !locked ? (
              <div data-testid="docb-gaps" style={{ flex: "none", margin: "10px 16px 0", padding: "8px 12px", borderRadius: 10, background: "color-mix(in srgb, var(--warn) 12%, transparent)", fontSize: 12.5, lineHeight: 1.5 }}>
                <b>Ще не заповнено:</b> {gaps.join(" · ")}
              </div>
            ) : null}

            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
              <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, opacity: locked ? 0.75 : 1 }}>
                {current.kind === "contract" ? (
                  <ContractForm data={data as ContractData} onChange={edit} parties={parties} products={products} templates={templates} onSaveParty={savePartyFromDoc} onSaveProduct={saveProduct} />
                ) : current.kind === "appendix" ? (
                  <AppendixForm
                    data={data as AppendixData}
                    onChange={edit}
                    parties={parties}
                    products={products}
                    templates={templates}
                    linkedContract={parentDoc?.number ?? null}
                    onSaveParty={savePartyFromDoc}
                    onSaveProduct={saveProduct}
                  />
                ) : current.kind === "invoice" ? (
                  <InvoiceForm
                    data={data as InvoiceData}
                    onChange={edit}
                    parties={parties}
                    products={products}
                    templates={templates}
                    onSaveProduct={saveProduct}
                    onSaveParty={savePartyFromDoc}
                    onSuggestNumber={() => void api.nextNumber("invoice").then((n) => n && edit({ ...(data as InvoiceData), number: n }))}
                  />
                ) : (
                  <UaInvoiceForm
                    data={data as UaInvoiceData}
                    onChange={edit}
                    parties={parties}
                    templates={templates}
                    onSaveParty={savePartyFromDoc}
                    onSuggestNumber={() => void api.nextNumber("ua_invoice").then((n) => n && edit({ ...(data as UaInvoiceData), number: n }))}
                  />
                )}
              </fieldset>
              <CheckNotice />
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
            <div style={{ maxWidth: 460, textAlign: "center" }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Конструктор документів</h2>
              <p style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.55, margin: "0 0 16px" }}>
                Контракт зі специфікацією, додаток до контракту, інвойс з пакувальним листом або видаткова накладна — із довідника компаній і товарів. Праворуч видно готовий документ;
                «Перевірити» звіряє реквізити, коди й ліміти контракту; Word, PDF чи ZIP — одним кліком.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                <button type="button" className="btn btn-primary" style={{ height: 36 }} onClick={() => create("contract")}>
                  ＋ Новий контракт
                </button>
                <button type="button" className="btn" style={{ height: 36 }} onClick={() => create("invoice")}>
                  ＋ Новий інвойс
                </button>
                <button type="button" className="btn" style={{ height: 36 }} onClick={() => create("ua_invoice")}>
                  ＋ Накладна / рахунок
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ---------- preview ---------- */}
      {mode === "doc" && current && data ? (
        <section data-testid="docb-preview" style={{ flex: "1 1 0", minWidth: 380, maxWidth: 760, borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--panel)" }}>
          <div style={{ flex: "none", padding: "10px 14px", fontSize: 12, color: "var(--muted)", display: "flex", gap: 8, alignItems: "center", borderBottom: "1px solid var(--border)" }}>
            <b style={{ color: "var(--text)", fontSize: 12.5 }}>Перегляд документа</b>
            <span>{preview.loading ? "оновлюю…" : "без колонтитулів — у Word вони є"}</span>
            <span style={{ marginLeft: "auto", fontWeight: 700, color: "var(--text)" }}>
              {fmtMoney(docTotal(current.kind, data))} {docCurrency(current.kind, data)}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
            {preview.error ? <p style={{ color: "var(--err)", fontSize: 13 }}>{preview.error}</p> : null}
            <div className="docb-paper" style={{ opacity: preview.loading ? 0.6 : 1 }} dangerouslySetInnerHTML={{ __html: preview.html }} />
          </div>
        </section>
      ) : null}
      <style>{PAPER_CSS}</style>
    </div>
  );
}

/**
 * Always under the form: the directory is typed in by people (and partly taken
 * from old documents), so the logist checks every field before downloading.
 */
function CheckNotice() {
  return (
    <div
      role="note"
      data-testid="docb-check-notice"
      style={{
        marginTop: 4,
        padding: "12px 14px",
        borderRadius: "var(--radius)",
        border: "1px solid color-mix(in srgb, var(--err) 35%, transparent)",
        background: "color-mix(in srgb, var(--err) 8%, transparent)",
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <b style={{ color: "var(--err)" }}>⚠ Обовʼязково перевірте всі поля перед завантаженням.</b>
      <div style={{ color: "var(--text)", marginTop: 2 }}>
        Реквізити, банк, підписанти, назви товарів, коди УКТ ЗЕД, кількості й ціни підставляються з довідника — він може бути неповним або застарілим. Натисніть «Перевірити», звірте
        документ у перегляді праворуч, а після завантаження — у Word.
      </div>
    </div>
  );
}

// The preview is mammoth's HTML of the filled .docx — styled as a sheet of paper.
const PAPER_CSS = `
.docb-paper{background:#fff;color:#111;font-family:"Times New Roman",Times,serif;font-size:12.5px;line-height:1.35;padding:28px 30px;border-radius:6px;box-shadow:0 1px 2px rgba(0,0,0,.06),0 6px 24px rgba(0,0,0,.08);transition:opacity .15s}
.docb-paper p{margin:0 0 4px}
.docb-paper table{width:100%;border-collapse:collapse;margin:8px 0 12px;table-layout:fixed}
.docb-paper td,.docb-paper th{border:1px solid #444;padding:4px 6px;vertical-align:top;word-wrap:break-word}
.docb-paper h1,.docb-paper h2,.docb-paper h3{font-size:14px;margin:10px 0 6px;text-align:center}
.docb-paper img{display:none}
`;
