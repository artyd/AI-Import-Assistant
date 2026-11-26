"use client";

// Конструктор документів (spec 012): logists assemble a contract + specification
// or an invoice + packing list from the team directory, watch the real Word
// document take shape on the right, and download it as .docx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/lib/docbuilder/api";
import type { ContractData, DirectoryParty, DirectoryProduct, DocData, DocFull, DocKind, DocSummary, InvoiceData, Party, Product } from "@/lib/docbuilder/model";
import { contractGaps, contractNumber, emptyContract, emptyInvoice, fmtMoney, invoiceGaps, itemsTotal, snapshot, todayIso } from "@/lib/docbuilder/model";
import { ContractForm } from "./ContractForm";
import { InvoiceForm } from "./InvoiceForm";
import { DirectoryPanel } from "./DirectoryPanel";
import { smallBtn } from "./fields";

type SaveState = "idle" | "saving" | "saved" | "error";

const KIND_LABEL: Record<DocKind, string> = { contract: "Контракт", invoice: "Інвойс" };

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
}

export function DocBuilderView() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [parties, setParties] = useState<DirectoryParty[]>([]);
  const [products, setProducts] = useState<DirectoryProduct[]>([]);
  const [mode, setMode] = useState<"doc" | "directory">("doc");
  const [current, setCurrent] = useState<DocFull | null>(null);
  const [data, setData] = useState<DocData | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [preview, setPreview] = useState<{ html: string; loading: boolean; error: string | null }>({ html: "", loading: false, error: null });
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const dirty = useRef(false);

  const refreshDocs = useCallback(() => api.listDocuments().then(setDocs).catch(() => undefined), []);

  useEffect(() => {
    Promise.all([api.listDocuments(), api.listParties(), api.listProducts()])
      .then(([d, p, pr]) => {
        setDocs(d);
        setParties(p);
        setProducts(pr);
        if (p.length === 0) setMode("directory");
      })
      .catch((e: Error) => setError(e.message || "Не вдалося завантажити конструктор"));
  }, []);

  const open = useCallback(async (id: string) => {
    setError(null);
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

  const seller = parties.find((p) => p.role === "seller") ?? null;

  const create = async (kind: DocKind, initial?: DocData, contractId?: string | null) => {
    setError(null);
    try {
      const d = await api.createDocument(kind, initial ?? (kind === "contract" ? emptyContract(seller ? snapshot(seller) : null) : emptyInvoice(seller ? snapshot(seller) : null)), contractId);
      await refreshDocs();
      await open(d.id);
    } catch (e) {
      setError((e as Error).message || "Не вдалося створити документ");
    }
  };

  // ---- autosave (debounced) ----
  useEffect(() => {
    if (!current || !data || !dirty.current) return;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try {
        const saved = await api.saveDocument(current.id, data);
        dirty.current = false;
        setSaveState("saved");
        setDocs((list) =>
          list.map((x) =>
            x.id === saved.id
              ? { ...x, number: saved.number, title: saved.title, date: data.date, currency: data.currency, total: itemsTotal(data.items), updatedAt: saved.updatedAt }
              : x,
          ),
        );
      } catch {
        setSaveState("error");
      }
    }, 800);
    return () => clearTimeout(t);
  }, [data, current]);

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
    dirty.current = true;
    setData(d);
  };

  // ---- directory callbacks ----
  const saveParty = async (p: DirectoryParty | Omit<DirectoryParty, "id">) => {
    const saved = "id" in p ? await api.updateParty(p) : await api.createParty(p);
    setParties((list) => {
      const rest = list.filter((x) => x.id !== saved.id);
      return [...rest, saved].sort((a, b) => a.role.localeCompare(b.role) || (a.nameEn || a.nameUk).localeCompare(b.nameEn || b.nameUk));
    });
  };
  const savePartyFromDoc = (p: Party, role: DirectoryParty["role"]) => saveParty({ ...p, role, note: "" });
  const saveProduct = async (p: DirectoryProduct | Product) => {
    const clean: Product = { nameEn: p.nameEn, nameUk: p.nameUk, hs: p.hs, reg: p.reg, manufacturer: p.manufacturer, countryEn: p.countryEn, countryUk: p.countryUk };
    const saved = "id" in p ? await api.updateProduct({ ...clean, id: p.id }) : await api.createProduct(clean);
    setProducts((list) => [...list.filter((x) => x.id !== saved.id), saved].sort((a, b) => (a.nameEn || a.nameUk).localeCompare(b.nameEn || b.nameUk)));
  };

  const gaps = useMemo(() => {
    if (!current || !data) return [];
    return current.kind === "contract" ? contractGaps(data as ContractData) : invoiceGaps(data as InvoiceData);
  }, [current, data]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? docs.filter((d) => `${d.number} ${d.title}`.toLowerCase().includes(s)) : docs;
  }, [docs, q]);

  const contractsById = useMemo(() => new Map(docs.filter((d) => d.kind === "contract").map((d) => [d.id, d])), [docs]);

  const download = async () => {
    if (!current || !data) return;
    setDownloading(true);
    setError(null);
    try {
      await api.downloadDocx(current.kind, data);
    } catch (e) {
      setError((e as Error).message || "Не вдалося сформувати Word");
    } finally {
      setDownloading(false);
    }
  };

  const makeInvoice = async () => {
    if (!current || current.kind !== "contract") return;
    try {
      if (dirty.current && data) await api.saveDocument(current.id, data);
      const inv = await api.invoiceFromContract(current.id);
      await refreshDocs();
      await open(inv.id);
    } catch (e) {
      setError((e as Error).message || "Не вдалося створити інвойс");
    }
  };

  const duplicate = () => {
    if (!current || !data) return;
    const today = todayIso();
    const copy: DocData =
      current.kind === "contract"
        ? { ...(data as ContractData), date: today, number: contractNumber(today, (data as ContractData).buyer.code) }
        : { ...(data as InvoiceData), date: today, number: "" };
    void create(current.kind, copy, current.contractId);
  };

  const remove = async () => {
    if (!current) return;
    try {
      await api.deleteDocument(current.id);
      setCurrent(null);
      setData(null);
      setConfirmDelete(false);
      await refreshDocs();
    } catch (e) {
      setError((e as Error).message || "Не вдалося видалити");
    }
  };

  const listRow = (d: DocSummary) => {
    const active = current?.id === d.id && mode === "doc";
    const parent = d.contractId ? contractsById.get(d.contractId) : undefined;
    return (
      <button
        key={d.id}
        type="button"
        className="nav-row"
        data-testid="docb-doc-row"
        onClick={() => open(d.id)}
        style={{
          textAlign: "left",
          width: "100%",
          border: "none",
          borderRadius: 10,
          padding: "8px 10px",
          cursor: "pointer",
          background: active ? "var(--active)" : "transparent",
          color: "var(--text)",
          font: "inherit",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.4,
              padding: "1px 6px",
              borderRadius: 6,
              background: d.kind === "contract" ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "color-mix(in srgb, var(--ok) 16%, transparent)",
              color: d.kind === "contract" ? "var(--accent)" : "var(--ok)",
            }}
          >
            {d.kind === "contract" ? "КОНТРАКТ" : "ІНВОЙС"}
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.number || "без номера"}</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>
          {d.title.split(" · ").slice(1).join(" · ") || "—"}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 1 }}>
          {[fmtDate(d.date), d.total ? `${fmtMoney(d.total)} ${d.currency}` : "", parent ? `до ${parent.number}` : ""].filter(Boolean).join(" · ")}
        </div>
      </button>
    );
  };

  return (
    <div data-testid="docb-view" style={{ height: "100%", display: "flex", minHeight: 0, background: "var(--bg)" }}>
      {/* ---------- list ---------- */}
      <aside style={{ width: 268, flex: "none", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--panel)" }}>
        <div style={{ padding: "14px 12px 8px", display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="btn btn-primary" style={{ flex: 1, height: 34, fontSize: 13 }} onClick={() => create("contract")} data-testid="docb-new-contract">
              ＋ Контракт
            </button>
            <button type="button" className="btn" style={{ flex: 1, height: 34, fontSize: 13 }} onClick={() => create("invoice")} data-testid="docb-new-invoice">
              ＋ Інвойс
            </button>
          </div>
          <input className="input" style={{ height: 32, fontSize: 13, padding: "0 10px" }} placeholder="Пошук за номером чи компанією" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 6px 8px" }}>
          {filtered.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--muted)", padding: "8px 8px" }}>{docs.length ? "Нічого не знайдено." : "Ще немає документів. Створіть перший контракт."}</p>
          ) : (
            filtered.map(listRow)
          )}
        </div>
        <div style={{ borderTop: "1px solid var(--border)", padding: 8 }}>
          <button
            type="button"
            className="nav-row"
            onClick={() => setMode("directory")}
            data-testid="docb-open-directory"
            style={{
              width: "100%",
              textAlign: "left",
              border: "none",
              borderRadius: 10,
              padding: "9px 10px",
              cursor: "pointer",
              background: mode === "directory" ? "var(--active)" : "transparent",
              color: "var(--text)",
              font: "inherit",
              fontSize: 13.5,
              fontWeight: 600,
            }}
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
        {mode === "directory" ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
            <div>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 4px" }}>Довідник</h2>
            <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 14px" }}>Компанії та товари, з яких збираються контракти й інвойси. Спільний для всієї команди.</p>
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
            />
            </div>
          </div>
        ) : current && data ? (
          <>
            <div style={{ flex: "none", padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, flex: "1 1 200px" }}>
                <div style={{ fontSize: 16, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} data-testid="docb-title">
                  {KIND_LABEL[current.kind]} {data.number || "без номера"}
                </div>
                <div style={{ fontSize: 12, color: saveState === "error" ? "var(--err)" : "var(--muted)" }} data-testid="docb-save-state">
                  {saveState === "saving" ? "Зберігаю…" : saveState === "error" ? "Не збережено — перевірте зʼєднання" : "Збережено"}
                  {current.kind === "contract" ? " · Контракт + Специфікація" : " · Інвойс + Пакувальний лист"}
                </div>
              </div>
              {current.kind === "contract" ? (
                <button type="button" style={{ ...smallBtn, height: 34 }} onClick={makeInvoice} data-testid="docb-make-invoice">
                  Інвойс до контракту
                </button>
              ) : null}
              <button type="button" style={{ ...smallBtn, height: 34 }} onClick={duplicate} data-testid="docb-duplicate">
                Дублювати
              </button>
              {confirmDelete ? (
                <button type="button" style={{ ...smallBtn, height: 34, color: "#fff", background: "var(--err)", borderColor: "var(--err)" }} onClick={remove} data-testid="docb-delete-confirm">
                  Так, видалити
                </button>
              ) : (
                <button type="button" style={{ ...smallBtn, height: 34, color: "var(--err)" }} onClick={() => setConfirmDelete(true)} data-testid="docb-delete">
                  Видалити
                </button>
              )}
              <button type="button" className="btn btn-primary" style={{ height: 34, fontSize: 13 }} onClick={download} disabled={downloading} data-testid="docb-download" title="Перед завантаженням обовʼязково перевірте всі поля">
                {downloading ? "Формую…" : "Завантажити Word"}
              </button>
            </div>
            {gaps.length ? (
              <div data-testid="docb-gaps" style={{ flex: "none", margin: "10px 16px 0", padding: "8px 12px", borderRadius: 10, background: "color-mix(in srgb, var(--warn) 12%, transparent)", fontSize: 12.5, lineHeight: 1.5 }}>
                <b>Ще не заповнено:</b> {gaps.join(" · ")}
              </div>
            ) : null}
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
              {current.kind === "contract" ? (
                <ContractForm
                  data={data as ContractData}
                  onChange={edit}
                  parties={parties}
                  products={products}
                  onSaveParty={savePartyFromDoc}
                  onSaveProduct={saveProduct}
                />
              ) : (
                <InvoiceForm data={data as InvoiceData} onChange={edit} parties={parties} products={products} onSaveProduct={saveProduct} onSaveParty={savePartyFromDoc} />
              )}
              <CheckNotice />
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
            <div style={{ maxWidth: 420, textAlign: "center" }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Конструктор документів</h2>
              <p style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.55, margin: "0 0 16px" }}>
                Збирайте контракт зі специфікацією або інвойс з пакувальним листом із довідника компаній і товарів. Праворуч видно готовий документ, а Word завантажується одним кліком.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                <button type="button" className="btn btn-primary" style={{ height: 36 }} onClick={() => create("contract")}>
                  ＋ Новий контракт
                </button>
                <button type="button" className="btn" style={{ height: 36 }} onClick={() => create("invoice")}>
                  ＋ Новий інвойс
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
        Реквізити, банк, підписанти, назви товарів, коди УКТ ЗЕД, кількості й ціни підставляються з довідника — він може бути неповним
        або застарілим. Звірте документ у перегляді праворуч, а після завантаження — у Word.
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
