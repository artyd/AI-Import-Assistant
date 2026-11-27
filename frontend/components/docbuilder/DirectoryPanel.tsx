"use client";

// Довідник: the team's companies (seller / buyers / consignors) and goods. Filled
// once, then every contract and invoice picks from it.
import { useEffect, useState } from "react";
import type { DirectoryParty, DirectoryProduct, PartyRole, Product, StampInfo, TemplateInfo, Unit } from "@/lib/docbuilder/model";
import { UNIT_OPTIONS } from "@/lib/docbuilder/model";
import { ImportFromDoc } from "./ImportFromDoc";
import { TemplatesPanel } from "./TemplatesPanel";
import { StampsPanel } from "./Stamps";
import { emptyParty, emptyProduct } from "@/lib/docbuilder/model";
import { Area, Field, Grid, Pair, Section, Select, smallBtn } from "./fields";

const ROLE_LABEL: Record<PartyRole, string> = {
  seller: "Продавці / постачальники",
  buyer: "Покупці",
  consignee: "Вантажоодержувачі",
  consignor: "Відправники / виробники",
  other: "Інші",
};

/** What «＋ Додати» in each group creates. */
const ROLE_ADD: Record<PartyRole, string> = {
  seller: "＋ Постачальник",
  buyer: "＋ Покупець",
  consignee: "＋ Вантажоодержувач",
  consignor: "＋ Відправник",
  other: "＋ Компанія",
};

interface Props {
  parties: DirectoryParty[];
  products: DirectoryProduct[];
  onSaveParty: (p: DirectoryParty | Omit<DirectoryParty, "id">) => Promise<void>;
  onDeleteParty: (id: string) => Promise<void>;
  onSaveProduct: (p: DirectoryProduct | Product) => Promise<void>;
  onDeleteProduct: (id: string) => Promise<void>;
  templates: TemplateInfo[];
  onTemplates: (list: TemplateInfo[]) => void;
  stamps: StampInfo[];
  onStamps: (list: StampInfo[]) => void;
  /** Open on this tab (e.g. «Печатки» from a document). */
  initialTab?: DirTab;
}

export type DirTab = "parties" | "products" | "stamps" | "templates";

type PartyDraft = DirectoryParty | Omit<DirectoryParty, "id">;
type ProductDraft = DirectoryProduct | Product;

export function DirectoryPanel({ parties, products, onSaveParty, onDeleteParty, onSaveProduct, onDeleteProduct, templates, onTemplates, stamps, onStamps, initialTab }: Props) {
  const [tab, setTab] = useState<DirTab>(initialTab ?? "parties");
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const [importing, setImporting] = useState(false);
  const [party, setParty] = useState<PartyDraft | null>(null);
  const [product, setProduct] = useState<ProductDraft | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The edit form sits on top of the list — bring it into view when it opens.
  const formOpen = Boolean(party || product);
  useEffect(() => {
    if (formOpen) document.querySelector('[data-testid="dir-party-form"],[data-testid="dir-product-form"]')?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [formOpen, party && "id" in party ? party.id : null, product && "id" in product ? product.id : null]);
  const newParty = (role: PartyRole) => setParty({ ...emptyParty(), role, note: "" });

  const tabBtn = (active: boolean): React.CSSProperties => ({
    ...smallBtn,
    height: 32,
    borderColor: active ? "var(--accent)" : "var(--border)",
    background: active ? "var(--active)" : "var(--surface)",
  });

  const save = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const delBtn = (id: string, onDelete: (id: string) => Promise<void>) =>
    confirmDel === id ? (
      <button type="button" style={{ ...smallBtn, color: "#fff", background: "var(--err)", borderColor: "var(--err)" }} onClick={() => save(() => onDelete(id)).then(() => setConfirmDel(null))}>
        Так, видалити
      </button>
    ) : (
      <button type="button" style={{ ...smallBtn, color: "var(--err)" }} onClick={() => setConfirmDel(id)}>
        Видалити
      </button>
    );

  return (
    <div data-testid="docb-directory">
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button type="button" style={tabBtn(tab === "parties")} onClick={() => setTab("parties")} data-testid="dir-tab-parties">
          Компанії · {parties.length}
        </button>
        <button type="button" style={tabBtn(tab === "products")} onClick={() => setTab("products")} data-testid="dir-tab-products">
          Товари · {products.length}
        </button>
        <button type="button" style={tabBtn(tab === "stamps")} onClick={() => setTab("stamps")} data-testid="dir-tab-stamps">
          Печатки · {stamps.length}
        </button>
        <button type="button" style={tabBtn(tab === "templates")} onClick={() => setTab("templates")} data-testid="dir-tab-templates">
          Шаблони Word · {templates.length}
        </button>
        {tab === "parties" || tab === "products" ? (
          <>
            <button type="button" style={{ ...smallBtn, height: 32, marginLeft: "auto" }} onClick={() => setImporting((v) => !v)} data-testid="dir-import-open">
              Додати з документа
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ height: 32, fontSize: 13 }}
              onClick={() => (tab === "parties" ? newParty("buyer") : setProduct(emptyProduct()))}
              data-testid="dir-add"
            >
              {tab === "parties" ? "＋ Нова компанія" : "＋ Новий товар"}
            </button>
          </>
        ) : null}
      </div>

      {importing && (tab === "parties" || tab === "products") ? (
        <ImportFromDoc
          parties={parties}
          products={products}
          onSaveParty={(p) => onSaveParty(p)}
          onSaveProduct={(p) => onSaveProduct(p)}
          onClose={() => setImporting(false)}
        />
      ) : null}

      {tab === "templates" ? <TemplatesPanel templates={templates} onChange={onTemplates} /> : null}
      {tab === "stamps" ? <StampsPanel stamps={stamps} parties={parties} onChange={onStamps} /> : null}

      {tab === "parties" && party ? (
        <Section title={"id" in party ? "Редагування компанії" : "Нова компанія"} testId="dir-party-form">
          <Grid cols="0.8fr 1.2fr">
            <Select
              label="Роль"
              value={party.role}
              options={(Object.keys(ROLE_LABEL) as PartyRole[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
              onChange={(v) => setParty({ ...party, role: v })}
            />
            <Field label="Суфікс номера контракту (для покупців)" value={party.code} onChange={(v) => setParty({ ...party, code: v })} placeholder="PNS" />
          </Grid>
          <Pair>
            <Field label="Назва (EN)" value={party.nameEn} onChange={(v) => setParty({ ...party, nameEn: v })} testId="dir-party-name-en" />
            <Field label="Назва (UA)" value={party.nameUk} onChange={(v) => setParty({ ...party, nameUk: v })} />
          </Pair>
          <Pair>
            <Field label="Країна (EN)" value={party.countryEn} onChange={(v) => setParty({ ...party, countryEn: v })} />
            <Field label="Країна (UA)" value={party.countryUk} onChange={(v) => setParty({ ...party, countryUk: v })} />
          </Pair>
          <Pair>
            <Field label="Підписант (EN)" value={party.signatoryEn} onChange={(v) => setParty({ ...party, signatoryEn: v })} placeholder="Director Ivanenko Olena" />
            <Field label="Підписант (UA, «в особі …»)" value={party.signatoryUk} onChange={(v) => setParty({ ...party, signatoryUk: v })} placeholder="Директора Іваненко Олени" />
          </Pair>
          <Pair>
            <Field label="Діє на підставі (EN)" value={party.basisEn} onChange={(v) => setParty({ ...party, basisEn: v })} placeholder="Statute" />
            <Field label="Діє на підставі (UA)" value={party.basisUk} onChange={(v) => setParty({ ...party, basisUk: v })} placeholder="Статуту" />
          </Pair>
          <Pair>
            <Area label="Адреса (EN)" rows={2} value={party.addressEn} onChange={(v) => setParty({ ...party, addressEn: v })} />
            <Area label="Адреса (UA)" rows={2} value={party.addressUk} onChange={(v) => setParty({ ...party, addressUk: v })} />
          </Pair>
          <Pair>
            <Area label="Реквізити та банк (EN)" rows={7} value={party.requisitesEn} onChange={(v) => setParty({ ...party, requisitesEn: v })} />
            <Area label="Реквізити та банк (UA)" rows={7} value={party.requisitesUk} onChange={(v) => setParty({ ...party, requisitesUk: v })} />
          </Pair>
          <Field label="Примітка" value={party.note} onChange={(v) => setParty({ ...party, note: v })} />
          {party.role === "seller" && templates.some((t) => t.kind === "invoice") ? (
            <Select
              label="Бланк інвойсу цього продавця"
              value={party.invoiceTemplateId ?? ""}
              options={[{ value: "", label: "Стандартний (PRIME FORCE)" }, ...templates.filter((t) => t.kind === "invoice").map((t) => ({ value: t.id, label: t.name }))]}
              onChange={(v) => setParty({ ...party, invoiceTemplateId: v || null })}
            />
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ height: 32, fontSize: 13 }}
              disabled={busy || !(party.nameEn.trim() || party.nameUk.trim())}
              onClick={() => save(() => onSaveParty(party)).then(() => setParty(null))}
              data-testid="dir-party-save"
            >
              Зберегти
            </button>
            <button type="button" style={{ ...smallBtn, height: 32 }} onClick={() => setParty(null)}>
              Скасувати
            </button>
          </div>
        </Section>
      ) : null}

      {tab === "products" && product ? (
        <Section title={"id" in product ? "Редагування товару" : "Новий товар"} testId="dir-product-form">
          <Pair>
            <Field label="Назва (EN)" value={product.nameEn} onChange={(v) => setProduct({ ...product, nameEn: v })} testId="dir-product-name-en" />
            <Field label="Назва (UA)" value={product.nameUk} onChange={(v) => setProduct({ ...product, nameUk: v })} />
          </Pair>
          <Grid cols="0.7fr 1.3fr">
            <Field label="Код УКТ ЗЕД (HS)" value={product.hs} onChange={(v) => setProduct({ ...product, hs: v })} />
            <Field label="Українська реєстрація" value={product.reg} onChange={(v) => setProduct({ ...product, reg: v })} />
          </Grid>
          <Grid cols="1.4fr 0.8fr 0.8fr 0.5fr">
            <Field label="Виробник" value={product.manufacturer} onChange={(v) => setProduct({ ...product, manufacturer: v })} />
            <Field label="Країна (EN)" value={product.countryEn} onChange={(v) => setProduct({ ...product, countryEn: v })} />
            <Field label="Країна (UA)" value={product.countryUk} onChange={(v) => setProduct({ ...product, countryUk: v })} />
            <Select label="Одиниця" value={product.unit ?? "kg"} options={UNIT_OPTIONS} onChange={(v: Unit) => setProduct({ ...product, unit: v })} />
          </Grid>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ height: 32, fontSize: 13 }}
              disabled={busy || !(product.nameEn.trim() || product.nameUk.trim())}
              onClick={() => save(() => onSaveProduct(product)).then(() => setProduct(null))}
              data-testid="dir-product-save"
            >
              Зберегти
            </button>
            <button type="button" style={{ ...smallBtn, height: 32 }} onClick={() => setProduct(null)}>
              Скасувати
            </button>
          </div>
        </Section>
      ) : null}

      {tab === "parties"
        ? (Object.keys(ROLE_LABEL) as PartyRole[]).map((role) => {
            const list = parties.filter((p) => p.role === role);
            return (
              <div key={role} style={{ marginBottom: 14 }} data-testid={`dir-group-${role}`}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 2px 6px" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {ROLE_LABEL[role]} · {list.length}
                  </span>
                  <button type="button" style={{ ...smallBtn, height: 24, fontSize: 12, color: "var(--accent)", marginLeft: "auto" }} onClick={() => newParty(role)} data-testid={`dir-add-${role}`}>
                    {ROLE_ADD[role]}
                  </button>
                </div>
                {list.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--faint)", padding: "8px 12px", border: "1px dashed var(--border)", borderRadius: 10 }}>Поки немає — додайте кнопкою праворуч.</div>
                ) : null}
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
                  {list.map((p) => (
                    <div key={p.id} data-testid="dir-party-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                          {p.nameEn || p.nameUk}
                          {p.code ? <span style={{ marginLeft: 8, fontSize: 11.5, color: "var(--accent)", fontWeight: 700 }}>{p.code}</span> : null}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {[p.nameUk && p.nameEn ? p.nameUk : "", p.signatoryUk || p.signatoryEn, p.addressEn.split("\n")[0]].filter(Boolean).join(" · ")}
                        </div>
                        {p.note ? <div style={{ fontSize: 11.5, color: "var(--warn)", marginTop: 1 }}>{p.note}</div> : null}
                      </div>
                      <button type="button" style={smallBtn} onClick={() => setParty(p)}>
                        Редагувати
                      </button>
                      {delBtn(p.id, onDeleteParty)}
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        : null}
      {tab === "parties" && parties.length === 0 && !party ? (
        <p style={{ fontSize: 13, color: "var(--muted)" }}>Довідник порожній. Додайте продавця і покупців — далі контракти збираються в кілька кліків.</p>
      ) : null}

      {tab === "products" ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
          {products.length === 0 && !product ? <p style={{ fontSize: 13, color: "var(--muted)" }}>Каталог товарів порожній.</p> : null}
          {products.map((p) => (
            <div key={p.id} data-testid="dir-product-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{p.nameEn || p.nameUk}</div>
                <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{[p.nameUk && p.nameEn ? p.nameUk : "", p.manufacturer, p.countryUk || p.countryEn, p.hs ? `HS ${p.hs}` : "", p.reg].filter(Boolean).join(" · ")}</div>
              </div>
              <button type="button" style={smallBtn} onClick={() => setProduct(p)}>
                Редагувати
              </button>
              {delBtn(p.id, onDeleteProduct)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
