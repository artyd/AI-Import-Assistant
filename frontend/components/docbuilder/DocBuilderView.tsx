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
import { KIND_COLOR, KindBadge, KindFilterMenu, NewDocMenu, type KindFilter } from "./TypeMenus";
import { Select } from "@/components/ui/Select";

type SaveState = "idle" | "saving" | "saved" | "error";
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
          <Select className="input" style={{ height: 32, fontSize: 13 }} value={action} onChange={(e) => setAction(e.target.value)} data-testid="docb-shipment-action">
            {actions.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
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
  const [filter, setFilter] = useState<KindFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [events, setEvents] = useState<DocEvent[] | null>(null);
  const [picker, setPicker] = useState<"from" | "to" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewMode, setPreviewMode] = useState<"html" | "pdf">("html");
  const [pdf, setPdf] = useState<{ url: string | null; loading: boolean; error: string | null }>({ url: null, loading: false, error: null });
  const formRef = useRef<HTMLDivElement>(null);
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

  // ---- exact preview: the PDF the server makes (slower, so only while that tab is open) ----
  useEffect(() => {
    if (previewMode !== "pdf" || !current || !data) return;
    const ctrl = new AbortController();
    setPdf((p) => ({ ...p, loading: true, error: null }));
    const t = setTimeout(() => {
      api
        .renderPdfBlob(current.kind, data, ctrl.signal)
        .then((b) =>
          setPdf((p) => {
            if (p.url) URL.revokeObjectURL(p.url);
            return { url: URL.createObjectURL(b), loading: false, error: null };
          }),
        )
        .catch((e: Error) => {
          if (e.name !== "AbortError") setPdf((p) => ({ ...p, loading: false, error: e.message || "PDF недоступний" }));
        });
    }, 900);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [previewMode, data, current]);

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

  const counts = useMemo(() => {
    const c: Record<KindFilter, number> = { all: docs.length, contract: 0, appendix: 0, invoice: 0, ua_invoice: 0 };
    for (const d of docs) c[d.kind]++;
    return c;
  }, [docs]);

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
      contract: { text: "КОНТРАКТ", color: KIND_COLOR.contract },
      appendix: { text: "ДОДАТОК", color: KIND_COLOR.appendix },
      invoice: { text: "ІНВОЙС", color: KIND_COLOR.invoice },
      ua_invoice: { text: "НАКЛАДНА", color: KIND_COLOR.ua_invoice },
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
      <aside style={{ width: "clamp(220px, 18vw, 280px)", flex: "none", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--panel)" }}>
        <div style={{ padding: "14px 12px 10px", display: "grid", gap: 8 }}>
          <NewDocMenu
            onCreate={(k) => void create(k)}
            onFromShipment={() => setPicker("from")}
            onAppendix={current?.kind === "contract" ? () => void run("appendix", () => openNew(api.appendixFrom(current.id))) : null}
          />
          <div style={{ position: "relative" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden style={{ position: "absolute", left: 10, top: 9, color: "var(--muted)" }}>
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" />
              <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            <input className="input" style={{ width: "100%", height: 32, fontSize: 13, padding: "0 10px 0 30px" }} placeholder="Пошук за номером чи компанією" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <KindFilterMenu value={filter} onChange={setFilter} counts={counts} />
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 8px 8px", display: "grid", alignContent: "start", gap: 3 }}>
          {filtered.length === 0 ? <p style={{ fontSize: 12.5, color: "var(--muted)", padding: "8px 8px" }}>{docs.length ? "Нічого не знайдено." : "Ще немає документів. Створіть перший контракт."}</p> : filtered.map(listRow)}
        </div>
        <div style={{ borderTop: "1px solid var(--border)", padding: 8 }}>
          <button
            type="button"
            className="nav-row"
            onClick={() => setMode("directory")}
            data-testid="docb-open-directory"
            style={{ width: "100%", textAlign: "left", border: "none", borderRadius: 10, padding: "9px 10px", cursor: "pointer", background: mode === "directory" ? "var(--active)" : "transparent", color: "var(--text)", font: "inherit", fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 10 }}
          >
            <span aria-hidden style={{ width: 28, height: 28, borderRadius: 8, display: "grid", placeItems: "center", background: "color-mix(in srgb, var(--accent) 12%, transparent)", color: "var(--accent)", fontSize: 14 }}>
              ☰
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block" }}>Довідник</span>
              <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)", fontWeight: 500 }}>
                {parties.length} компаній · {products.length} товарів
              </span>
            </span>
          </button>
        </div>
      </aside>

      {/* ---------- editor ---------- */}
      <main style={{ flex: "1.2 1 0", minWidth: 440, display: "flex", flexDirection: "column", minHeight: 0 }}>
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
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 20px" }}>
            <h2 style={{ fontSize: 19, fontWeight: 800, margin: "0 0 4px" }}>Довідник</h2>
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
            {/* header: what this is, where it is in its life, what to do next */}
            <div style={{ flex: "none", padding: "14px 18px 12px", borderBottom: "1px solid var(--border)", display: "grid", gap: 12, background: "var(--panel)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px 12px", minWidth: 0, flexWrap: "wrap" }}>
                <KindBadge kind={current.kind} size={38} />
                <div style={{ minWidth: 180, flex: "1 1 220px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 17, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} data-testid="docb-title">
                      {current.kind === "ua_invoice" ? ((data as UaInvoiceData).docType === "rahunok" ? "Рахунок" : "Накладна") : KIND_LABEL[current.kind]}{" "}
                      {current.kind === "appendix" ? current.title.split(" · ")[0] : data.number ? `№ ${data.number}` : "без номера"}
                    </span>
                    <StatusPill status={current.status} />
                    {current.version > 1 ? <span style={{ fontSize: 11.5, color: "var(--muted)" }}>версія {current.version}</span> : null}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span
                      data-testid="docb-save-state"
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, color: saveState === "error" ? "var(--err)" : locked ? "var(--muted)" : saveState === "saving" ? "var(--warn)" : "var(--ok)", fontWeight: 600, flex: "none" }}
                    >
                      <span aria-hidden style={{ width: 6, height: 6, borderRadius: 9, background: "currentColor" }} />
                      {locked ? "Редагування закрите" : saveState === "saving" ? "Зберігаю…" : saveState === "error" ? "Не збережено — перевірте зʼєднання" : "Збережено"}
                    </span>
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      · {KIND_SUBTITLE[current.kind]}
                      {parentDoc ? ` · до ${shortTitle(parentDoc)}` : ""}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto", flex: "none" }}>
                <button type="button" style={{ ...smallBtn, height: 34 }} onClick={check} disabled={busy === "check"} data-testid="docb-check">
                  {busy === "check" ? "Перевіряю…" : "🔍 Перевірити"}
                </button>
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
                <div style={{ display: "flex", flex: "none" }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ height: 34, fontSize: 13, borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                    onClick={() => run("download", () => api.downloadDoc(current.kind, data, "docx"))}
                    disabled={busy === "download"}
                    data-testid="docb-download"
                    title="Перед завантаженням обовʼязково перевірте всі поля"
                  >
                    {busy === "download" ? "Формую…" : "⬇ Завантажити Word"}
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
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <Stepper status={current.status} />
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {current.status === "draft" ? (
                    <button type="button" style={{ ...smallBtn, height: 30, color: "var(--info)", borderColor: "color-mix(in srgb, var(--info) 45%, var(--border))" }} onClick={() => changeStatus("checked")} data-testid="docb-mark-checked">
                      ✓ Перевірено
                    </button>
                  ) : null}
                  {current.status === "checked" ? (
                    <>
                      <button type="button" style={{ ...smallBtn, height: 30 }} onClick={() => changeStatus("draft")} data-testid="docb-mark-draft">
                        В чернетку
                      </button>
                      <button type="button" style={{ ...smallBtn, height: 30, color: "var(--ok)", borderColor: "color-mix(in srgb, var(--ok) 45%, var(--border))" }} onClick={() => changeStatus("sent")} data-testid="docb-mark-sent">
                        ✈ Відправлено
                      </button>
                    </>
                  ) : null}
                  {current.status === "sent" ? (
                    <button type="button" style={{ ...smallBtn, height: 30 }} onClick={() => run("version", () => openNew(api.newVersion(current.id)))} data-testid="docb-new-version">
                      Нова версія
                    </button>
                  ) : null}
                </div>
                {current.kind === "contract" || current.kind === "appendix" ? (
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>Створити з нього:</span>
                    {current.kind === "contract" ? (
                      <button type="button" style={{ ...smallBtn, height: 30 }} onClick={() => run("appendix", () => openNew(api.appendixFrom(current.id)))} data-testid="docb-make-appendix">
                        ＋ Додаток
                      </button>
                    ) : null}
                    <button type="button" style={{ ...smallBtn, height: 30 }} onClick={() => run("invoice", () => openNew(api.invoiceFrom(current.id)))} data-testid="docb-make-invoice">
                      {current.kind === "contract" ? "Інвойс до контракту" : "Інвойс до додатку"}
                    </button>
                  </div>
                ) : null}
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
              <div data-testid="docb-findings" style={{ flex: "none", margin: "10px 16px 0", padding: "10px 12px", borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface)", fontSize: 12.5, maxHeight: 220, overflowY: "auto" }}>
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
              <div data-testid="docb-events" style={{ flex: "none", margin: "10px 16px 0", padding: "10px 12px", borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface)", fontSize: 12.5, maxHeight: 180, overflowY: "auto" }}>
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

            <div ref={formRef} className="docb-form" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 18px 18px" }}>
              <SectionNav container={formRef} watch={`${current.id}:${current.kind}`} gaps={locked ? 0 : gaps.length} />
              {gaps.length && !locked ? (
                <div data-testid="docb-gaps" style={{ margin: "0 0 12px", padding: "9px 12px", borderRadius: 12, background: "color-mix(in srgb, var(--warn) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warn) 30%, transparent)", fontSize: 12.5, lineHeight: 1.5, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <b style={{ marginRight: 2 }}>Ще не заповнено:</b>
                  {gaps.map((g) => (
                    <span key={g} style={{ padding: "1px 8px", borderRadius: 99, background: "color-mix(in srgb, var(--warn) 16%, var(--surface))", whiteSpace: "nowrap" }}>
                      {g}
                    </span>
                  ))}
                </div>
              ) : null}
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
          <EmptyState onCreate={(k) => void create(k)} onFromShipment={() => setPicker("from")} hasDirectory={parties.length > 0} onDirectory={() => setMode("directory")} />
        )}
      </main>

      {/* ---------- preview ---------- */}
      {mode === "doc" && current && data ? (
        <section data-testid="docb-preview" style={{ flex: "1 1 0", minWidth: 320, maxWidth: 780, borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0, background: "color-mix(in srgb, var(--panel) 70%, var(--bg))" }}>
          <div style={{ flex: "none", padding: "10px 14px", fontSize: 12, color: "var(--muted)", display: "flex", gap: 10, alignItems: "center", borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
            <div role="tablist" aria-label="Режим перегляду" style={{ display: "inline-flex", padding: 2, borderRadius: 9, background: "var(--bg)", border: "1px solid var(--border)" }}>
              {(
                [
                  ["html", "Перегляд"],
                  ["pdf", "Точно (PDF)"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={previewMode === m}
                  onClick={() => setPreviewMode(m)}
                  data-testid={`docb-preview-${m}`}
                  style={{ border: "none", borderRadius: 7, padding: "4px 10px", font: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", background: previewMode === m ? "var(--surface)" : "transparent", color: previewMode === m ? "var(--text)" : "var(--muted)", boxShadow: previewMode === m ? "0 1px 2px rgba(0,0,0,.08)" : "none" }}
                >
                  {label}
                </button>
              ))}
            </div>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{previewMode === "html" ? (preview.loading ? "оновлюю…" : "без колонтитулів — у Word вони є") : pdf.loading ? "формую PDF…" : "так, як надрукується"}</span>
            <span style={{ marginLeft: "auto", fontWeight: 800, color: "var(--text)", fontSize: 13, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
              {fmtMoney(docTotal(current.kind, data))} {docCurrency(current.kind, data)}
            </span>
          </div>
          {previewMode === "html" ? (
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 18 }}>
              {preview.error ? <p style={{ color: "var(--err)", fontSize: 13 }}>{preview.error}</p> : null}
              <div className="docb-paper" style={{ opacity: preview.loading ? 0.6 : 1 }} dangerouslySetInnerHTML={{ __html: preview.html }} />
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex" }}>
              {pdf.error ? <p style={{ color: "var(--err)", fontSize: 13, padding: 16 }}>{pdf.error}</p> : null}
              {pdf.url ? <iframe title="PDF документа" src={`${pdf.url}#toolbar=0&view=FitH`} data-testid="docb-preview-frame" style={{ flex: 1, border: 0, opacity: pdf.loading ? 0.6 : 1, transition: "opacity .15s" }} /> : null}
              {!pdf.url && !pdf.error ? <p style={{ color: "var(--muted)", fontSize: 13, padding: 16 }}>Формую PDF — кілька секунд…</p> : null}
            </div>
          )}
        </section>
      ) : null}
      <style>{PAPER_CSS}</style>
    </div>
  );
}

/** Draft → checked → sent, as three steps with the current one lit. */
function Stepper({ status }: { status: DocStatus }) {
  const steps: { s: DocStatus; label: string }[] = [
    { s: "draft", label: "Чернетка" },
    { s: "checked", label: "Перевірено" },
    { s: "sent", label: "Відправлено" },
  ];
  const at = steps.findIndex((x) => x.s === status);
  return (
    <ol aria-label="Етап документа" style={{ display: "flex", alignItems: "center", gap: 6, listStyle: "none", margin: 0, padding: 0 }}>
      {steps.map((x, i) => {
        const done = i < at;
        const now = i === at;
        const color = now ? STATUS_COLOR[x.s] === "var(--muted)" ? "var(--accent)" : STATUS_COLOR[x.s] : done ? "var(--ok)" : "var(--faint)";
        return (
          <li key={x.s} style={{ display: "flex", alignItems: "center", gap: 6 }} aria-current={now ? "step" : undefined}>
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: 99,
                display: "grid",
                placeItems: "center",
                fontSize: 11,
                fontWeight: 800,
                color: now || done ? "#fff" : "var(--muted)",
                background: now || done ? color : "transparent",
                border: `1.5px solid ${now || done ? color : "var(--border)"}`,
              }}
            >
              {done ? "✓" : i + 1}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: now ? 800 : 600, color: now ? "var(--text)" : "var(--muted)" }}>{x.label}</span>
            {i < steps.length - 1 ? <span aria-hidden style={{ width: 22, height: 2, borderRadius: 2, background: done ? "var(--ok)" : "var(--border)" }} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The form's table of contents: a sticky row of its sections (read from the
 * DOM, so every form gets it for free) that jumps to one and lights the one in
 * view.
 */
function SectionNav({ container, watch, gaps }: { container: React.RefObject<HTMLDivElement | null>; watch: string; gaps: number }) {
  const [items, setItems] = useState<{ id: string; title: string }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const read = () => {
      const secs = [...root.querySelectorAll<HTMLElement>("section[data-testid]")].filter((el) => !el.parentElement?.closest("section"));
      setItems(secs.map((el) => ({ id: el.dataset.testid!, title: el.querySelector("header button")?.textContent?.trim() || el.dataset.testid! })));
      return secs;
    };
    const secs = read();
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 70;
      let cur: string | null = secs[0]?.dataset.testid ?? null;
      for (const el of secs) if (el.getBoundingClientRect().top <= top) cur = el.dataset.testid ?? cur;
      setActive(cur);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [container, watch]);
  if (items.length < 2) return <div style={{ height: 14 }} />;
  return (
    <nav
      aria-label="Розділи документа"
      data-testid="docb-section-nav"
      style={{ position: "sticky", top: 0, zIndex: 5, display: "flex", gap: 4, overflowX: "auto", padding: "10px 0", margin: "0 0 4px", background: "linear-gradient(var(--bg) 78%, transparent)", scrollbarWidth: "none" }}
    >
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => container.current?.querySelector(`[data-testid="${it.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          style={{
            flex: "none",
            border: `1px solid ${active === it.id ? "color-mix(in srgb, var(--accent) 50%, var(--border))" : "var(--border)"}`,
            background: active === it.id ? "color-mix(in srgb, var(--accent) 10%, var(--surface))" : "var(--surface)",
            color: active === it.id ? "var(--accent)" : "var(--text)",
            borderRadius: 99,
            padding: "4px 11px",
            font: "inherit",
            fontSize: 12.5,
            fontWeight: 650,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {it.title}
        </button>
      ))}
      {gaps ? (
        <span style={{ marginLeft: "auto", flex: "none", alignSelf: "center", fontSize: 12, fontWeight: 700, color: "var(--warn)", whiteSpace: "nowrap" }} title="Поля, які ще треба заповнити">
          ⚠ не заповнено: {gaps}
        </span>
      ) : (
        <span style={{ marginLeft: "auto", flex: "none", alignSelf: "center", fontSize: 12, fontWeight: 700, color: "var(--ok)", whiteSpace: "nowrap" }}>✓ усе заповнено</span>
      )}
    </nav>
  );
}

/** No document open: one card per kind, the way in for a new logist. */
function EmptyState({ onCreate, onFromShipment, hasDirectory, onDirectory }: { onCreate: (k: "contract" | "invoice" | "ua_invoice") => void; onFromShipment: () => void; hasDirectory: boolean; onDirectory: () => void }) {
  const cards: { kind: "contract" | "invoice" | "ua_invoice"; title: string; hint: string }[] = [
    { kind: "contract", title: "Контракт", hint: "Двомовний контракт зі специфікацією (Додаток №1). Додатки й інвойси потім — з нього в один клік." },
    { kind: "invoice", title: "Інвойс + пакувальний лист", hint: "На бланку продавця: товари, партії, ваги, упаковка — суми пакувального листа звіряються з інвойсом." },
    { kind: "ua_invoice", title: "Накладна / рахунок", hint: "Продаж в Україні: гривні, ПДВ, сума прописом." },
  ];
  return (
    <div style={{ flex: 1, overflowY: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 28 }}>
      <div style={{ maxWidth: 720, width: "100%" }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 6px" }}>Конструктор документів</h2>
        <p style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.55, margin: "0 0 18px" }}>
          Оберіть, що зібрати. Сторони й товари беруться з довідника, праворуч одразу видно готовий документ, а «Перевірити» звіряє реквізити, коди й ліміти контракту.
        </p>
        {/* 6 columns: the three kinds take two each, the two helpers three each — every tile the same height */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gridAutoRows: "1fr", gap: 10 }}>
          {cards.map((c) => (
            <Tile key={c.kind} span={2} testId={`docb-empty-${c.kind}`} onClick={() => onCreate(c.kind)} badge={<KindBadge kind={c.kind} size={36} />} title={c.title} hint={c.hint} cta="Створити →" color={KIND_COLOR[c.kind]} />
          ))}
          <Tile
            span={3}
            testId="docb-empty-from-shipment"
            onClick={onFromShipment}
            badge={<TileBadge color="var(--info)">⇩</TileBadge>}
            title="З документів постачання"
            hint="Контракт чи інвойс із прочитаних документів постачання Штурмана — сторони й товари підставляться самі, решту перевірте."
            cta="Обрати постачання →"
            color="var(--info)"
          />
          <Tile
            span={3}
            testId="docb-empty-directory"
            onClick={onDirectory}
            badge={<TileBadge color="#0d9488">☰</TileBadge>}
            title={hasDirectory ? "Довідник" : "Заповнити довідник"}
            hint="Компанії, товари й шаблони Word, з яких збираються всі документи. Спільний для всієї команди."
            cta={hasDirectory ? "Відкрити довідник →" : "Заповнити →"}
            color="#0d9488"
          />
        </div>
      </div>
    </div>
  );
}

function TileBadge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      style={{
        width: 36,
        height: 36,
        borderRadius: 9,
        display: "grid",
        placeItems: "center",
        fontSize: 16,
        fontWeight: 800,
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

/** One tile of the empty state: badge, title, a line of what it does, a call to action. */
function Tile({ span, testId, onClick, badge, title, hint, cta, color }: { span: number; testId: string; onClick: () => void; badge: React.ReactNode; title: string; hint: string; cta: string; color: string }) {
  return (
    <button
      type="button"
      className="docb-card"
      onClick={onClick}
      data-testid={testId}
      style={{ gridColumn: `span ${span}`, textAlign: "left", display: "flex", flexDirection: "column", gap: 8, padding: 16, borderRadius: 14, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", font: "inherit", cursor: "pointer", minWidth: 0 }}
    >
      {badge}
      <span style={{ fontSize: 14.5, fontWeight: 800 }}>{title}</span>
      <span style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.45 }}>{hint}</span>
      <span style={{ marginTop: "auto", fontSize: 12.5, fontWeight: 700, color }}>{cta}</span>
    </button>
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
.docb-paper{position:relative;background:#fff;color:#111;font-family:"Times New Roman",Times,serif;font-size:12.5px;line-height:1.35;padding:30px;border-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.06),0 10px 30px rgba(15,23,42,.10);transition:opacity .15s;overflow:hidden}
.docb-paper p{margin:0 0 4px}
.docb-paper table{width:100%;border-collapse:collapse;margin:8px 0 12px;table-layout:fixed}
.docb-paper td,.docb-paper th{border:1px solid #444;padding:4px 6px;vertical-align:top;word-wrap:break-word}
.docb-paper h1,.docb-paper h2,.docb-paper h3{font-size:14px;margin:10px 0 6px;text-align:center}
.docb-paper img{display:none}
.docb-form section[data-testid]{scroll-margin-top:56px}
.docb-card{transition:border-color .12s, box-shadow .12s, transform .12s}
.docb-card:hover{border-color:color-mix(in srgb, var(--accent) 45%, var(--border));box-shadow:var(--shadow);transform:translateY(-1px)}
`;
