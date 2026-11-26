"use client";

// «Додати з документа»: drop an old contract / invoice → Штурман reads the
// companies (requisites, bank, signatory) and goods it states → the user ticks
// what to keep, sets the role, and saves. Nothing is saved without review.
import { useRef, useState } from "react";
import * as api from "@/lib/docbuilder/api";
import type { DirectoryParty, DirectoryProduct, Party, PartyRole, Product } from "@/lib/docbuilder/model";
import { smallBtn } from "./fields";
import { Select } from "@/components/ui/Select";

const ROLE_OPTIONS: { value: PartyRole; label: string }[] = [
  { value: "seller", label: "Продавець / постачальник" },
  { value: "buyer", label: "Покупець" },
  { value: "consignee", label: "Вантажоодержувач" },
  { value: "consignor", label: "Відправник / виробник" },
  { value: "other", label: "Інше" },
];

interface Props {
  parties: DirectoryParty[];
  products: DirectoryProduct[];
  onSaveParty: (p: Omit<DirectoryParty, "id">) => Promise<void>;
  onSaveProduct: (p: Product) => Promise<void>;
  onClose: () => void;
}

type Cand = (Party & { role: PartyRole }) & { keep: boolean; known: boolean };
type ProdCand = Product & { keep: boolean; known: boolean };

const key = (v: string) => v.toLowerCase().replace(/[«»"'“”.,]/g, " ").replace(/\s+/g, " ").trim();

export function ImportFromDoc({ parties, products, onSaveParty, onSaveProduct, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"read" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Cand[] | null>(null);
  const [goods, setGoods] = useState<ProdCand[]>([]);
  const [done, setDone] = useState<string | null>(null);

  const read = async (file: File) => {
    setBusy("read");
    setError(null);
    setDone(null);
    try {
      const r = await api.extractFromFile(file);
      const knownP = new Set(parties.map((p) => key(p.nameEn || p.nameUk)));
      const knownG = new Set(products.map((p) => key(p.nameEn || p.nameUk)));
      setCompanies(r.companies.map((c) => ({ ...c, known: knownP.has(key(c.nameEn || c.nameUk)), keep: !knownP.has(key(c.nameEn || c.nameUk)) })));
      setGoods(r.products.map((p) => ({ ...p, known: knownG.has(key(p.nameEn || p.nameUk)), keep: !knownG.has(key(p.nameEn || p.nameUk)) })));
      setNote(r.note);
    } catch (e) {
      setError((e as Error).message || "Не вдалося прочитати документ");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    let n = 0;
    try {
      for (const c of companies ?? []) {
        if (!c.keep) continue;
        const { keep: _k, known: _kn, ...party } = c;
        await onSaveParty({ ...party, note: "Додано з документа — перевірте реквізити", invoiceTemplateId: null });
        n++;
      }
      for (const g of goods) {
        if (!g.keep) continue;
        const { keep: _k, known: _kn, ...product } = g;
        await onSaveProduct(product);
        n++;
      }
      setDone(`Додано в довідник: ${n}`);
      setCompanies(null);
      setGoods([]);
    } catch (e) {
      setError((e as Error).message || "Не вдалося зберегти");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="dir-import" style={{ border: "1px solid var(--accent)", borderRadius: "var(--radius)", padding: 14, marginBottom: 14, background: "var(--surface)", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <b style={{ fontSize: 14 }}>Додати з документа</b>
        <span style={{ fontSize: 12.5, color: "var(--muted)" }}>Контракт, інвойс чи специфікація (PDF, Word, Excel, фото) — Штурман прочитає компанії й товари.</span>
        <button type="button" style={{ ...smallBtn, marginLeft: "auto" }} onClick={onClose}>
          Закрити
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          ref={input}
          type="file"
          accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
          style={{ display: "none" }}
          data-testid="dir-import-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void read(f);
            e.target.value = "";
          }}
        />
        <button type="button" className="btn btn-primary" style={{ height: 32, fontSize: 13 }} disabled={busy !== null} onClick={() => input.current?.click()}>
          {busy === "read" ? "Читаю документ…" : "Обрати файл"}
        </button>
        {done ? <span style={{ fontSize: 13, color: "var(--ok)" }}>{done}</span> : null}
        {error ? <span style={{ fontSize: 13, color: "var(--err)" }}>{error}</span> : null}
      </div>
      {note ? <div style={{ fontSize: 12.5, color: "var(--warn)" }}>{note}</div> : null}

      {companies ? (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>Компанії · {companies.length}</div>
          {companies.length === 0 ? <div style={{ fontSize: 13, color: "var(--muted)" }}>Компаній не знайдено.</div> : null}
          {companies.map((c, i) => (
            <div key={i} data-testid="dir-import-company" style={{ display: "grid", gridTemplateColumns: "auto 1fr 220px", gap: 10, alignItems: "start", padding: 10, borderRadius: 10, background: "var(--panel)" }}>
              <input type="checkbox" checked={c.keep} onChange={(e) => setCompanies(companies.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))} style={{ marginTop: 3 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {c.nameEn || c.nameUk}
                  {c.known ? <span style={{ marginLeft: 8, fontSize: 11.5, color: "var(--muted)" }}>вже є в довіднику</span> : null}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "pre-wrap" }}>
                  {[c.nameUk && c.nameEn ? c.nameUk : "", c.signatoryEn || c.signatoryUk, c.requisitesEn || c.addressEn].filter(Boolean).join("\n").slice(0, 400)}
                </div>
              </div>
              <Select className="input" style={{ height: 32, fontSize: 13 }} value={c.role} onChange={(e) => setCompanies(companies.map((x, j) => (j === i ? { ...x, role: e.target.value as PartyRole } : x)))}>
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
          ))}
          {goods.length ? <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase" }}>Товари · {goods.length}</div> : null}
          {goods.map((g, i) => (
            <label key={i} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={g.keep} onChange={(e) => setGoods(goods.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))} />
              <span>
                <b>{g.nameEn || g.nameUk}</b> <span style={{ color: "var(--muted)" }}>{[g.manufacturer, g.hs ? `HS ${g.hs}` : "", g.reg].filter(Boolean).join(" · ")}</span>
                {g.known ? <span style={{ marginLeft: 6, fontSize: 11.5, color: "var(--muted)" }}>вже є</span> : null}
              </span>
            </label>
          ))}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" className="btn btn-primary" style={{ height: 32, fontSize: 13 }} disabled={busy !== null || ![...companies, ...goods].some((x) => x.keep)} onClick={save} data-testid="dir-import-save">
              {busy === "save" ? "Зберігаю…" : "Додати вибране в довідник"}
            </button>
            <span style={{ fontSize: 12, color: "var(--warn)" }}>Перевірте реквізити після додавання — розпізнавання може помилятися.</span>
          </div>
        </>
      ) : null}
    </div>
  );
}
