"use client";

// Supplier-instruction builder (TZ §1, approved mockup). Left: structured form
// pre-filled from the shipment with a source badge per field. Right: the letter
// (EN for the supplier / UK check copy) rendered server-side from the same draft
// — a deterministic template, 0 tokens. Штурман helps in a side chat by PROPOSING
// values that the user accepts here; «Доопрацювати з ШІ» proposes extra clauses.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError, downloadBlob } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { streamChat } from "@/lib/sse";
import { Markdown } from "@/components/Markdown";
import { IconSpinner } from "@/components/icons";
import type { Workspace } from "@/lib/types";
import {
  CATEGORY_LABEL,
  INCOTERMS,
  SOURCE_LABEL,
  TRANSPORT_LABEL,
  getPath,
  setField,
  type Category,
  type CheckItem,
  type DirectoryEntry,
  type FieldSource,
  type InstructionDraft,
  type InstructionVersion,
  type Transport,
} from "@/lib/instruction";
import s from "./instruction.module.css";

type Preview = { en: string; uk: string; subject: string; missing: { path: string; label: string }[] };
type ChatMsg = { role: "user" | "assistant"; text: string; tools: string[] };

const SRC_CLASS: Partial<Record<FieldSource, string>> = {
  template: s.srcTpl,
  qdpro: s.srcQ,
  pubchem: s.srcQ,
  previous: s.srcPrev,
  manual: s.srcManual,
};

export default function InstructionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [versions, setVersions] = useState<InstructionVersion[]>([]);
  const [current, setCurrent] = useState<InstructionVersion | null>(null); // null = unsaved prefill
  const [draft, setDraft] = useState<InstructionDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [lang, setLang] = useState<"en" | "uk">("en");
  const [dir, setDir] = useState<DirectoryEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [user, authLoading, router]);

  // ── load ──────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    const [w, v, d] = await Promise.all([
      api<{ workspace: Workspace }>(`/api/workspaces/${id}`),
      api<{ versions: InstructionVersion[] }>(`/api/workspaces/${id}/instructions`),
      api<{ entries: DirectoryEntry[] }>(`/api/directory`),
    ]);
    setWorkspace(w.workspace);
    setVersions(v.versions);
    setDir(d.entries);
    if (v.versions[0]) {
      setCurrent(v.versions[0]);
      setDraft(v.versions[0].draft);
    } else {
      const p = await api<{ draft: InstructionDraft }>(`/api/workspaces/${id}/instruction/prefill`);
      setCurrent(null);
      setDraft(p.draft);
    }
    setDirty(false);
  }, [id]);

  useEffect(() => {
    if (user) load().catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [user, load]);

  // ── live preview (debounced, server-rendered, no LLM) ─────────────────────
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => {
      api<Preview>(`/api/workspaces/${id}/instruction/preview`, { method: "POST", body: { draft } })
        .then(setPreview)
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [draft, id]);

  const edit = (fn: (d: InstructionDraft) => InstructionDraft) => {
    setDraft((d) => (d ? fn(d) : d));
    setDirty(true);
  };
  const setF = (path: string, value: string, source: FieldSource = "manual") => edit((d) => setField(d, path, value, source));

  const missing = preview?.missing ?? [];
  const isMissing = (path: string) => missing.some((m) => m.path === path);
  const locked = current?.status === "approved" || current?.status === "sent";

  // ── persistence ───────────────────────────────────────────────────────────
  /** Saves the screen; an approved/sent version is never edited in place → new version. */
  const save = useCallback(async (): Promise<InstructionVersion> => {
    if (!draft) throw new Error("no draft");
    if (current && !dirty) return current;
    let v: InstructionVersion;
    if (!current || locked) {
      v = (await api<{ version: InstructionVersion }>(`/api/workspaces/${id}/instructions`, { method: "POST", body: { draft } })).version;
    } else {
      v = (await api<{ version: InstructionVersion }>(`/api/workspaces/${id}/instructions/${current.version}`, { method: "PATCH", body: { draft } })).version;
    }
    setCurrent(v);
    setDirty(false);
    setVersions((vs) => [v, ...vs.filter((x) => x.version !== v.version)].sort((a, b) => b.version - a.version));
    return v;
  }, [draft, current, dirty, locked, id]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === "missing_fields") setError("Спершу заповніть обовʼязкові поля.");
      else setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const setStatus = (status: "approved" | "sent") =>
    run(status, async () => {
      const v0 = await save();
      const v = (await api<{ version: InstructionVersion }>(`/api/workspaces/${id}/instructions/${v0.version}`, { method: "PATCH", body: { status } })).version;
      setCurrent(v);
      setVersions((vs) => vs.map((x) => (x.version === v.version ? v : x)));
      setNotice(status === "approved" ? `Версію v${v.version} затверджено — за нею перевірятимуться документи постачальника.` : `v${v.version} позначено як надіслану.`);
    });

  const download = (format: "docx" | "pdf") =>
    run(format, async () => {
      const v = await save();
      await downloadBlob(
        `/api/workspaces/${id}/instructions/${v.version}/render?lang=${lang}&format=${format}`,
        `instruction-v${v.version}-${lang}.${format}`
      );
    });

  const copy = () =>
    run("copy", async () => {
      await navigator.clipboard.writeText(lang === "en" ? preview?.en ?? "" : preview?.uk ?? "");
      setNotice("Лист скопійовано.");
    });

  const email = () => {
    if (!draft || !preview) return;
    const to = draft.supplierEmail.trim();
    const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(preview.subject)}&body=${encodeURIComponent(preview.en)}`;
    window.location.href = href;
    setNotice(locked ? "Лист відкрито в поштовому клієнті. Після відправки позначте версію як надіслану." : "Лист відкрито в поштовому клієнті. Затвердіть версію, щоб за нею перевірялись документи.");
  };

  const openVersion = (ver: number) => {
    const v = versions.find((x) => x.version === ver);
    if (!v) return;
    if (dirty && !confirm("Незбережені зміни буде втрачено. Продовжити?")) return;
    setCurrent(v);
    setDraft(v.draft);
    setDirty(false);
  };

  // ── directory templates ───────────────────────────────────────────────────
  const saveTemplate = (kind: DirectoryEntry["kind"], e: Partial<DirectoryEntry> & { name: string }) =>
    run(`tpl-${kind}`, async () => {
      const existing = dir.find((x) => x.kind === kind && x.name.trim().toLowerCase() === e.name.trim().toLowerCase());
      const r = existing
        ? await api<{ entry: DirectoryEntry }>(`/api/directory/${existing.id}`, { method: "PATCH", body: e })
        : await api<{ entry: DirectoryEntry }>(`/api/directory`, { method: "POST", body: { kind, ...e } });
      setDir((d) => [...d.filter((x) => x.id !== r.entry.id), r.entry]);
      setNotice(`Шаблон «${r.entry.name}» збережено для всієї команди.`);
    });

  // ── proposals from Штурман ────────────────────────────────────────────────
  const acceptProposal = (i: number) =>
    edit((d) => {
      const p = d.proposals[i];
      if (!p) return d;
      const next = setField(d, p.path, p.value, "documents");
      next.proposals = d.proposals.filter((_, j) => j !== i);
      return next;
    });
  const rejectProposal = (i: number) => edit((d) => ({ ...d, proposals: d.proposals.filter((_, j) => j !== i) }));

  /** After Штурман answered: pull its proposals in without touching local edits. */
  const syncProposals = useCallback(async () => {
    const r = await api<{ versions: InstructionVersion[] }>(`/api/workspaces/${id}/instructions`);
    const latest = r.versions[0];
    if (!latest) return;
    setVersions(r.versions);
    if (!current) {
      setCurrent(latest);
      setDraft((d) => (d ? { ...d, proposals: latest.draft.proposals } : latest.draft));
    } else if (latest.version === current.version) {
      setDraft((d) => (d ? { ...d, proposals: latest.draft.proposals } : d));
    }
  }, [id, current]);

  if (!draft) {
    return (
      <div className={s.root}>
        <div className={s.center}>{error ? <span className={s.err}>{error}</span> : <IconSpinner size={22} />}</div>
      </div>
    );
  }

  // ── small field helpers ───────────────────────────────────────────────────
  // Plain render helpers (NOT components): a component defined in render would
  // remount the <input> on every keystroke and drop focus.
  const src = (path: string) => {
    const from = draft.sources[path];
    return from ? <span className={`${s.src} ${SRC_CLASS[from] ?? ""}`}>{SOURCE_LABEL[from]}</span> : null;
  };
  const field = (label: string, path: string, opts: { placeholder?: string; area?: boolean } = {}) => {
    const { placeholder, area } = opts;
    const v = String(getPath(draft, path) ?? "");
    const cls = `${s.in} ${isMissing(path) ? s.missing : ""}`;
    return (
      <div className={s.f} key={path}>
        <label>
          {label} {src(path)}
        </label>
        {area ? (
          <textarea className={cls} value={v} placeholder={placeholder} onChange={(e) => setF(path, e.target.value)} />
        ) : (
          <input className={cls} value={v} placeholder={placeholder ?? (isMissing(path) ? "обовʼязково" : "")} onChange={(e) => setF(path, e.target.value)} />
        )}
      </div>
    );
  };
  const secState = (paths: string[]) =>
    paths.some(isMissing) ? <span className={s.miss}>⚠ {paths.filter(isMissing).length} поля</span> : <span className={s.ok}>✓</span>;
  const toggleItem = (list: "docs" | "labels", key: string) =>
    edit((d) => ({ ...d, [list]: d[list].map((x: CheckItem) => (x.key === key ? { ...x, checked: !x.checked } : x)) }));
  const addCustom = (list: "docs" | "labels", label: string) =>
    edit((d) => ({
      ...d,
      [list]: [...d[list], { key: `custom-${Date.now()}`, label, labelUk: label, checked: true, source: "custom" as const }],
    }));

  const own = dir.filter((x) => x.kind === "own_company");
  const suppliers = dir.filter((x) => x.kind === "supplier");
  const consignees = dir.filter((x) => x.kind === "consignee" || x.kind === "own_company");
  const contacts = dir.filter((x) => x.kind === "contact");
  const trilateral = draft.hints.contractType === "trilateral" && !!draft.hints.intermediary;
  const statusBadge = !current ? (
    <span className={`${s.badge} ${s.bDraft}`}>● нова, не збережена</span>
  ) : current.status === "approved" ? (
    <span className={`${s.badge} ${s.bOk}`}>✓ затверджено</span>
  ) : current.status === "sent" ? (
    <span className={`${s.badge} ${s.bSent}`}>✉ надіслано</span>
  ) : (
    <span className={`${s.badge} ${s.bDraft}`}>● чернетка</span>
  );

  const letter = lang === "en" ? preview?.en ?? "" : preview?.uk ?? "";

  return (
    <div className={s.root}>
      <div className={s.top}>
        <Link href={`/workspaces/${id}`} className={s.mark} title="До поставки">
          Ш
        </Link>
        <div className={s.crumbs}>
          <Link href={`/workspaces/${id}`}>{workspace?.number ?? "Постачання"}</Link> › <b>Інструкція постачальнику</b>
        </div>
        <div className={s.sp} />
        {versions.length > 0 && (
          <select className={s.in} style={{ width: "auto", padding: "6px 10px" }} value={current?.version ?? ""} onChange={(e) => openVersion(Number(e.target.value))}>
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} · {v.status === "approved" ? "затверджено" : v.status === "sent" ? "надіслано" : "чернетка"}
              </option>
            ))}
          </select>
        )}
        {statusBadge}
        {dirty && <span className={s.tokens} style={{ color: "var(--warn)" }}>незбережено</span>}
        <button className="btn" onClick={() => run("save", async () => { await save(); setNotice("Збережено."); })} disabled={busy === "save" || (!dirty && !!current)}>
          {busy === "save" ? <IconSpinner size={15} /> : null} {locked && dirty ? "Зберегти як нову версію" : "Зберегти"}
        </button>
        {current?.status !== "approved" && current?.status !== "sent" ? (
          <button className="btn btn-primary" onClick={() => setStatus("approved")} disabled={missing.length > 0 || busy === "approved"} title={missing.length ? "Заповніть обовʼязкові поля" : ""}>
            Затвердити{current ? ` v${current.version}` : ""}
          </button>
        ) : current.status === "approved" && !dirty ? (
          <button className="btn btn-primary" onClick={() => setStatus("sent")}>Позначити надісланою</button>
        ) : null}
      </div>

      <div className={s.wrap}>
        <div className={s.form}>
          {missing.length > 0 ? (
            <div className={s.alert}>
              ⚠
              <div>
                <b>{missing.length} обовʼязкових полів не заповнено</b> — {missing.map((m) => m.label.toLowerCase()).join(", ")}. Затвердження недоступне, доки їх не заповнено.{" "}
                <button className={s.link} onClick={() => setChatOpen(true)}>Заповнити зі Штурманом →</button>
              </div>
            </div>
          ) : (
            <div className={`${s.alert} ${s.alertOk}`}>✓<div>Усі обовʼязкові поля заповнені — лист готовий до затвердження.</div></div>
          )}
          {notice && <div className={s.hint} style={{ marginBottom: 12 }} onClick={() => setNotice(null)}>{notice}</div>}
          {error && <div className={s.err} style={{ marginBottom: 12 }}>{error}</div>}

          {draft.proposals.length > 0 && (
            <div className={s.proposals}>
              <h3>💬 Пропозиції Штурмана · {draft.proposals.length}</h3>
              {draft.proposals.map((p, i) => (
                <div className={s.prop} key={`${p.path}-${i}`}>
                  <div>
                    <b>{p.path}</b>: {p.value}
                    <small>{p.reason}</small>
                  </div>
                  <div className={s.propActs}>
                    <button className="btn btn-primary" onClick={() => acceptProposal(i)}>Прийняти</button>
                    <button className="btn" onClick={() => rejectProposal(i)}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 1 · from */}
          <div className={s.sec}>
            <h2><span className={s.n}>1</span>Від імені{secState(["from.name"])}</h2>
            <div className={s.sel}>
              <select
                className={`${s.in} ${isMissing("from.name") ? s.missing : ""}`}
                value={draft.from.directoryId ?? ""}
                onChange={(e) => {
                  const r = own.find((x) => x.id === e.target.value);
                  edit((d) => ({
                    ...d,
                    from: r ? { directoryId: r.id, name: r.name, address: r.address, signer: r.signer, email: r.email, phone: r.phone } : { ...d.from, directoryId: null },
                    sources: { ...d.sources, "from.name": "template" },
                  }));
                }}
              >
                <option value="">{draft.from.name ? `${draft.from.name} (не з довідника)` : "— оберіть компанію групи —"}</option>
                {own.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}{o.address ? ` · ${o.address}` : ""}</option>
                ))}
              </select>
            </div>
            <div className={s.row} style={{ marginTop: 12 }}>
              {field("Компанія (шапка)", "from.name")}
              {field("Підписант", "from.signer")}
            </div>
            {field("Адреса", "from.address")}
            <div className={s.row}>
              {field("Телефон", "from.phone")}
              {field("E-mail", "from.email")}
            </div>
            <button className="btn" onClick={() => saveTemplate("own_company", { name: draft.from.name, address: draft.from.address, signer: draft.from.signer, email: draft.from.email, phone: draft.from.phone })} disabled={!draft.from.name.trim()}>
              Зберегти як шаблон компанії
            </button>
          </div>

          {/* 2 · category */}
          <div className={s.sec}>
            <h2><span className={s.n}>2</span>Категорія товару<span className={s.ok}>✓</span></h2>
            <div className={s.seg}>
              {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                <button key={c} className={`${s.segBtn} ${draft.category === c ? s.segOn : ""}`} onClick={() => edit((d) => ({ ...d, category: c }))}>
                  {CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
            <div className={s.hint} style={{ marginTop: 10 }}>
              За замовчуванням — субстанція. Категорія впливає на типовий перелік документів і полів етикетки; змінивши її, перевірте розділи 8–9.
            </div>
          </div>

          {/* 3 · product */}
          <div className={s.sec}>
            <h2><span className={s.n}>3</span>Товар і код{secState(["product.name", "product.quantity"])}</h2>
            <div className={s.row3}>
              {field("Назва товару", "product.name")}
              {field("Кількість", "product.quantity")}
              <div className={s.f}>
                <label>Одиниця</label>
                <select className={s.in} value={draft.product.unit} onChange={(e) => setF("product.unit", e.target.value)}>
                  {["kg", "g", "t", "l", "pcs"].map((u) => <option key={u}>{u}</option>)}
                </select>
              </div>
            </div>
            <div className={s.row}>
              {field("Ґатунок / марка", "product.grade")}
              {field("CAS", "product.cas")}
            </div>
            <div className={s.row}>
              {field("Код УКТ ЗЕД", "product.hsCode")}
              {field("Реєстраційний номер (якщо є)", "product.regNumber", { placeholder: "UA/… або АВ-…" })}
            </div>
            {draft.hints.qdproSummary && <div className={s.hint}>{draft.hints.qdproSummary}</div>}
          </div>

          {/* 4 · consignor */}
          <div className={s.sec}>
            <h2><span className={s.n}>4</span>Відправник (Consignor){secState(["consignor.name"])}</h2>
            {suppliers.length > 0 && (
              <div className={s.sel} style={{ marginBottom: 12 }}>
                <select className={s.in} value="" onChange={(e) => {
                  const r = suppliers.find((x) => x.id === e.target.value);
                  if (r) edit((d) => ({ ...d, consignor: { name: r.name, address: r.address, country: r.country }, supplierEmail: r.email || d.supplierEmail, sources: { ...d.sources, "consignor.name": "template", "consignor.address": "template" } }));
                }}>
                  <option value="">— підставити з шаблону постачальника —</option>
                  {suppliers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            )}
            {field("Назва", "consignor.name")}
            {field("Адреса", "consignor.address", { area: true })}
            <div className={s.row}>
              {field("Країна", "consignor.country")}
              {field("E-mail постачальника (для відправки)", "supplierEmail")}
            </div>
            <button className="btn" onClick={() => saveTemplate("supplier", { name: draft.consignor.name, address: draft.consignor.address, country: draft.consignor.country, email: draft.supplierEmail })} disabled={!draft.consignor.name.trim()}>
              Зберегти як шаблон постачальника
            </button>
          </div>

          {/* 5 · consignee */}
          <div className={`${s.sec} ${trilateral ? s.tri : ""}`}>
            <h2><span className={s.n}>5</span>Одержувач (Consignee){secState(["consignee.name"])}</h2>
            {trilateral && (
              <>
                <div className={s.hint} style={{ marginBottom: 12 }}>
                  🔀 <b>Тристороння схема</b> ({draft.consignor.name || "постачальник"} → {draft.hints.intermediary} → {draft.hints.recipient}). Оберіть, кого вказати consignee в усіх документах — після затвердження це перевірятиметься в AWB/CMR, COO і пакувальному листі.
                </div>
                <div className={s.seg} style={{ marginBottom: 12 }}>
                  <button className={`${s.segBtn} ${draft.consigneeChoice === "intermediary" ? s.segOn : ""}`} onClick={() => edit((d) => ({ ...d, consigneeChoice: "intermediary", consignee: { ...d.consignee, name: d.hints.intermediary }, finalConsignee: d.finalConsignee || d.hints.recipient, sources: { ...d.sources, "consignee.name": "parties" } }))}>
                    {draft.hints.intermediary} (посередник)
                  </button>
                  <button className={`${s.segBtn} ${draft.consigneeChoice === "recipient" ? s.segOn : ""}`} onClick={() => edit((d) => ({ ...d, consigneeChoice: "recipient", consignee: { ...d.consignee, name: d.hints.recipient }, finalConsignee: "", sources: { ...d.sources, "consignee.name": "parties" } }))}>
                    {draft.hints.recipient} (покупець)
                  </button>
                </div>
              </>
            )}
            {consignees.length > 0 && (
              <div className={s.sel} style={{ marginBottom: 12 }}>
                <select className={s.in} value="" onChange={(e) => {
                  const r = consignees.find((x) => x.id === e.target.value);
                  if (r) edit((d) => ({ ...d, consignee: { name: r.name, address: r.address, country: r.country }, sources: { ...d.sources, "consignee.name": "template", "consignee.address": "template" } }));
                }}>
                  <option value="">— підставити з шаблону —</option>
                  {consignees.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            )}
            {field("Назва", "consignee.name")}
            {field("Адреса", "consignee.address", { area: true })}
            {field("Кінцевий вантажоодержувач (якщо інший)", "finalConsignee")}
            <button className="btn" onClick={() => saveTemplate("consignee", { name: draft.consignee.name, address: draft.consignee.address, country: draft.consignee.country })} disabled={!draft.consignee.name.trim()}>
              Зберегти як шаблон одержувача
            </button>
          </div>

          {/* 6 · contract */}
          <div className={s.sec}>
            <h2><span className={s.n}>6</span>Контракт{secState(["contract.number"])}</h2>
            <div className={s.row}>
              {field("Номер", "contract.number")}
              {field("Дата", "contract.date")}
            </div>
            {trilateral && <div className={s.hint}>Лист іде постачальнику — вказуйте контракт <b>постачальник → {draft.hints.intermediary}</b> (вхідне плече).</div>}
          </div>

          {/* 7 · terms */}
          <div className={s.sec}>
            <h2><span className={s.n}>7</span>Умови поставки{secState(["terms.incoterm", "terms.place"])}</h2>
            <div className={s.row}>
              <div className={s.f}>
                <label>Incoterms {src("terms.incoterm")}</label>
                <select className={`${s.in} ${isMissing("terms.incoterm") ? s.missing : ""}`} value={draft.terms.incoterm} onChange={(e) => setF("terms.incoterm", e.target.value)}>
                  <option value="">—</option>
                  {INCOTERMS.map((i) => <option key={i}>{i}</option>)}
                </select>
              </div>
              {field("Місце відвантаження", "terms.place")}
            </div>
            <div className={s.row}>
              {field("Порт / аеропорт призначення", "terms.destination")}
              {field("Кінцевий пункт", "terms.finalDestination")}
            </div>
            <div className={s.f}>
              <label>Вид транспорту {src("terms.transport")}</label>
              <div className={s.seg}>
                {(Object.keys(TRANSPORT_LABEL) as Transport[]).map((t) => (
                  <button key={t} className={`${s.segBtn} ${draft.terms.transport === t ? s.segOn : ""}`} onClick={() => edit((d) => ({ ...d, terms: { ...d.terms, transport: t } }))}>
                    {TRANSPORT_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 8 · documents */}
          <div className={s.sec}>
            <h2><span className={s.n}>8</span>Пакет документів<span className={s.ok}>{draft.docs.filter((x) => x.checked).length} обрано</span></h2>
            <CheckList items={draft.docs.filter((x) => x.source !== "qdpro")} onToggle={(k) => toggleItem("docs", k)} />
            {draft.docs.some((x) => x.source === "qdpro") && (
              <>
                <div className={s.grp}>За кодом {draft.product.hsCode} <span className={`${s.src} ${s.srcQ}`}>qdpro</span></div>
                <CheckList items={draft.docs.filter((x) => x.source === "qdpro")} onToggle={(k) => toggleItem("docs", k)} />
              </>
            )}
            <AddItem placeholder="Додати свій документ (англ.)" onAdd={(v) => addCustom("docs", v)} />
          </div>

          {/* 9 · labels */}
          <div className={s.sec}>
            <h2><span className={s.n}>9</span>Маркування<span className={s.ok}>✓</span></h2>
            <CheckList items={draft.labels} onToggle={(k) => toggleItem("labels", k)} />
            <AddItem placeholder="Додати поле етикетки (англ.)" onAdd={(v) => addCustom("labels", v)} />
            <div style={{ marginTop: 12 }}>
              {field("Примітки до маркування", "labelNotes", { area: true })}
            </div>
            {draft.hints.lessons.map((l) => <div key={l} className={s.hint}>💡 {l}</div>)}
          </div>

          {/* 10 · originals */}
          <div className={s.sec}>
            <h2><span className={s.n}>10</span>Оригінали курʼєром{secState(["originals.contact", "originals.phone", "originals.address"])}</h2>
            {contacts.length > 0 && (
              <div className={s.sel} style={{ marginBottom: 12 }}>
                <select className={s.in} value="" onChange={(e) => {
                  const r = contacts.find((x) => x.id === e.target.value);
                  if (r) edit((d) => ({ ...d, originals: { contact: r.signer || r.name, phone: r.phone, address: r.address }, sources: { ...d.sources, "originals.contact": "template", "originals.phone": "template", "originals.address": "template" } }));
                }}>
                  <option value="">— підставити з шаблону контакту —</option>
                  {contacts.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            )}
            <div className={s.row}>
              {field("Контактна особа", "originals.contact")}
              {field("Телефон", "originals.phone")}
            </div>
            {field("Адреса доставки оригіналів", "originals.address")}
            <button className="btn" onClick={() => saveTemplate("contact", { name: `Оригінали — ${draft.originals.contact}`, signer: draft.originals.contact, phone: draft.originals.phone, address: draft.originals.address })} disabled={!draft.originals.contact.trim()}>
              Зберегти як шаблон контакту
            </button>
          </div>

          {draft.extra.length > 0 && (
            <div className={s.sec}>
              <h2><span className={s.n}>✦</span>Додаткові вимоги (з ШІ)</h2>
              {draft.extra.map((x, i) => (
                <div key={i} className={s.prop}>
                  <div>{x.en}<small>{x.uk}</small></div>
                  <button className="btn" onClick={() => edit((d) => ({ ...d, extra: d.extra.filter((_, j) => j !== i) }))}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── preview ── */}
        <div className={s.preview}>
          <div className={s.ptabs}>
            <div className={s.tabs}>
              <button className={`${s.tab} ${lang === "en" ? s.tabOn : ""}`} onClick={() => setLang("en")}>EN · постачальнику</button>
              <button className={`${s.tab} ${lang === "uk" ? s.tabOn : ""}`} onClick={() => setLang("uk")}>UK · перевірка</button>
            </div>
            <div className={s.sp} />
            <span className={s.tokens}>⚡ шаблон · 0 токенів</span>
          </div>
          <div className={s.letter}>{highlightPlaceholders(letter)}</div>
          <div className={s.actions}>
            <button className="btn" onClick={copy} disabled={!preview}>⧉ Копіювати</button>
            <button className="btn" onClick={() => download("docx")} disabled={busy === "docx"}>{busy === "docx" ? <IconSpinner size={14} /> : "⬇"} DOCX</button>
            <button className="btn" onClick={() => download("pdf")} disabled={busy === "pdf"}>{busy === "pdf" ? <IconSpinner size={14} /> : "⬇"} PDF</button>
            <button className="btn" onClick={email} disabled={!preview} title={draft.supplierEmail ? `Кому: ${draft.supplierEmail}` : "E-mail постачальника не вказано — адресу введете в поштовому клієнті"}>✉ E-mail</button>
            <div className={s.sp} />
            <button className="btn" style={{ background: "var(--accentSoft)", color: "var(--accent)", borderColor: "transparent" }} onClick={() => setRefineOpen(true)}>✦ Доопрацювати з ШІ</button>
            <button className="btn btn-primary" onClick={() => setChatOpen((o) => !o)}>💬 Спитати Штурмана</button>
          </div>
        </div>
      </div>

      {chatOpen && (
        <InstructionChat
          workspaceId={id}
          version={current?.version ?? null}
          missing={missing.map((m) => m.label)}
          ensureSaved={save}
          onClose={() => setChatOpen(false)}
          onAnswered={syncProposals}
        />
      )}
      {refineOpen && (
        <RefineModal
          ensureSaved={save}
          workspaceId={id}
          draft={draft}
          onClose={() => setRefineOpen(false)}
          onAccept={(clauses) => {
            edit((d) => ({ ...d, extra: [...d.extra, ...clauses] }));
            setRefineOpen(false);
          }}
        />
      )}
    </div>
  );
}

function highlightPlaceholders(text: string) {
  const parts = text.split(/(\[[A-ZА-ЯІЇЄҐ .№]+\])/g);
  return parts.map((p, i) => (/^\[[A-ZА-ЯІЇЄҐ .№]+\]$/.test(p) ? <span key={i} className={s.ph}>{p}</span> : p));
}

function CheckList({ items, onToggle }: { items: CheckItem[]; onToggle: (key: string) => void }) {
  return (
    <div className={s.chk}>
      {items.map((x) => (
        <label key={x.key}>
          <input type="checkbox" checked={x.checked} onChange={() => onToggle(x.key)} />
          <span>
            {x.labelUk || x.label}
            {x.source === "previous" && <span className={`${s.src} ${s.srcPrev}`} style={{ marginLeft: 6 }}>попередня</span>}
            {x.source === "custom" && <span className={`${s.src} ${s.srcManual}`} style={{ marginLeft: 6 }}>своє</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

function AddItem({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className={s.addRow}>
      <input className={s.in} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && v.trim()) { onAdd(v.trim()); setV(""); } }} />
      <button className="btn" disabled={!v.trim()} onClick={() => { onAdd(v.trim()); setV(""); }}>Додати</button>
    </div>
  );
}

function InstructionChat({
  workspaceId,
  version,
  missing,
  ensureSaved,
  onClose,
  onAnswered,
}: {
  workspaceId: string;
  version: number | null;
  missing: string[];
  ensureSaved: () => Promise<InstructionVersion>;
  onClose: () => void;
  onAnswered: () => Promise<void>;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    { role: "assistant", text: missing.length ? `Бачу незаповнені поля: ${missing.join(", ")}. Пошукати їх у документах поставки?` : "Усі обовʼязкові поля заповнені. Чим допомогти з інструкцією?", tools: [] },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const conv = useRef<string | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [msgs]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setInput("");
    setMsgs((m) => [...m, { role: "user", text, tools: [] }, { role: "assistant", text: "", tools: [] }]);
    try {
      const v = await ensureSaved(); // the agent reads the SAVED draft
      const message = `[Екран «Інструкція постачальнику», версія v${v.version}. Допоможи з інструкцією: читай get_instruction_draft, значення пропонуй через propose_instruction_fields.]\n${text}`;
      const patch = (fn: (last: ChatMsg) => ChatMsg) => setMsgs((m) => [...m.slice(0, -1), fn(m[m.length - 1]!)]);
      await streamChat(
        `/api/workspaces/${workspaceId}/chat`,
        { message, conversationId: conv.current },
        {
          onToken: (e) => patch((l) => ({ ...l, text: l.text + e.text })),
          onToolCall: (e) => patch((l) => ({ ...l, tools: [...l.tools, e.tool] })),
          onDone: (e) => {
            conv.current = e.conversationId;
            patch((l) => ({ ...l, text: e.message || l.text }));
          },
          onError: (e) => patch((l) => ({ ...l, text: `${l.text}\n⚠ ${e.message}` })),
        }
      );
      await onAnswered();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.drawer}>
      <div className={s.dh}>
        <span className={s.mark} style={{ width: 24, height: 24, fontSize: 13 }}>Ш</span>Штурман · інструкція{version ? ` v${version}` : ""}
        <button className={s.x} onClick={onClose}>✕</button>
      </div>
      <div className={s.msgs}>
        {msgs.map((m, i) => (
          <div key={i} className={`${s.m} ${m.role === "user" ? s.mu : ""}`}>
            {m.tools.length > 0 && <div className={s.tool}>🔎 {m.tools.join(" · ")}</div>}
            {m.role === "assistant" ? (m.text ? <Markdown>{m.text}</Markdown> : <IconSpinner size={14} />) : m.text}
          </div>
        ))}
        <div ref={end} />
      </div>
      {msgs.length <= 1 && (
        <div className={s.quick}>
          <button onClick={() => send("Знайди в документах значення для незаповнених полів і запропонуй їх.")}>Заповнити порожні поля</button>
          <button onClick={() => send("Перевір інструкцію: чи нічого не пропущено для цього товару і коду?")}>Перевірити інструкцію</button>
        </div>
      )}
      <div className={s.dinput}>
        <input className={s.in} value={input} placeholder="Запитайте про інструкцію…" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(input)} disabled={busy} />
        <button className="btn btn-primary" onClick={() => send(input)} disabled={busy || !input.trim()}>{busy ? <IconSpinner size={14} /> : "↑"}</button>
      </div>
    </div>
  );
}

function RefineModal({
  workspaceId,
  draft,
  ensureSaved,
  onClose,
  onAccept,
}: {
  workspaceId: string;
  draft: InstructionDraft;
  ensureSaved: () => Promise<InstructionVersion>;
  onClose: () => void;
  onAccept: (clauses: { en: string; uk: string }[]) => void;
}) {
  const [request, setRequest] = useState("");
  const [clauses, setClauses] = useState<{ en: string; uk: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ask = async () => {
    setBusy(true);
    setErr(null);
    try {
      const v = await ensureSaved();
      const r = await api<{ clauses: { en: string; uk: string }[] }>(`/api/workspaces/${workspaceId}/instructions/${v.version}/refine`, {
        method: "POST",
        body: { request, draft },
      });
      setClauses(r.clauses);
      if (!r.clauses.length) setErr("ШІ не запропонував змін — уточніть запит.");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const diff = useMemo(() => (clauses ?? []).map((c) => `+ ${c.en}`).join("\n\n"), [clauses]);
  return (
    <div className={s.modal} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={s.mbox}>
        <h3>✦ Доопрацювати з ШІ</h3>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>Опишіть нестандартну вимогу — ШІ запропонує додатковий пункт до шаблонного листа. Нічого не зміниться, доки ви не приймете.</div>
        <textarea className={s.in} style={{ marginTop: 12, minHeight: 70 }} value={request} placeholder="Напр.: додай вимогу зберігати при 2–8 °C і вкласти термоіндикатор у кожну коробку" onChange={(e) => setRequest(e.target.value)} />
        {clauses && clauses.length > 0 && <div className={s.diff}><span className={s.diffAdd}>{diff}</span></div>}
        {err && <div className={s.err}>{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, alignItems: "center" }}>
          <span style={{ marginRight: "auto", fontSize: 12.5, color: "var(--muted)" }}>≈ 1 виклик Sonnet</span>
          <button className="btn" onClick={onClose}>{clauses?.length ? "Відхилити" : "Скасувати"}</button>
          {clauses?.length ? (
            <button className="btn btn-primary" onClick={() => onAccept(clauses)}>Прийняти</button>
          ) : (
            <button className="btn btn-primary" onClick={ask} disabled={busy || request.trim().length < 3}>{busy ? <IconSpinner size={14} /> : null} Запропонувати</button>
          )}
        </div>
      </div>
    </div>
  );
}
