"use client";

// Інвойс + Пакувальний лист: one document, two pages (INVOICE / PACKING LIST)
// on the seller's letterhead.
import type { Batch, DirectoryParty, DirectoryProduct, InvoiceData, InvoiceItem, Party, PartyRole, Product, TemplateInfo, Unit } from "@/lib/docbuilder/model";
import { INCOTERMS, UNIT_OPTIONS, batchTotals, emptyParty, fmtMoney, fmtNum, itemsTotal, lineTotal, unitLabel } from "@/lib/docbuilder/model";
import { TemplateSelect } from "./sections";
import { useState } from "react";
import { Area, Check, Field, Grid, NumField, Pair, Section, Select, smallBtn } from "./fields";
import { ItemPicker } from "./ItemPicker";

interface Props {
  data: InvoiceData;
  onChange: (d: InvoiceData) => void;
  parties: DirectoryParty[];
  products: DirectoryProduct[];
  onSaveProduct: (p: Product) => Promise<void>;
  onSaveParty: (p: Party, role: PartyRole) => Promise<void>;
  templates: TemplateInfo[];
  onSuggestNumber: () => void;
}

const emptyBatch = (it?: InvoiceItem): Batch => ({
  nameEn: it?.nameEn ?? "",
  reg: it?.reg ?? "",
  batch: "",
  net: it?.qty ?? 0,
  gross: 0,
  packages: "",
  packagesCount: 0,
});

function PartyPick({ label, parties, onPick, onNew, testId }: { label: string; parties: DirectoryParty[]; onPick: (p: DirectoryParty) => void; onNew: () => void; testId?: string }) {
  return (
    <select
      className="input"
      style={{ height: 30, fontSize: 12.5, padding: "0 8px", maxWidth: 260 }}
      value=""
      onChange={(e) => {
        if (e.target.value === "__new") return onNew();
        const hit = parties.find((p) => p.id === e.target.value);
        if (hit) onPick(hit);
      }}
      data-testid={testId}
    >
      <option value="">{label}</option>
      <option value="__new">＋ Нова компанія — ввести вручну</option>
      {parties.map((p) => (
        <option key={p.id} value={p.id}>
          {p.nameEn || p.nameUk}
        </option>
      ))}
    </select>
  );
}

/** «＋ У довідник» for a company typed by hand in the invoice. */
function SaveToDirectory({ name, address, role, parties, onSave, testId }: { name: string; address: string; role: PartyRole; parties: DirectoryParty[]; onSave: (p: Party, role: PartyRole) => Promise<void>; testId?: string }) {
  const [savedName, setSavedName] = useState<string | null>(null);
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const known = parties.some((p) => (p.nameEn || p.nameUk).trim().toLowerCase() === key);
  if (known && savedName !== key) return null;
  return (
    <button
      type="button"
      style={{ ...smallBtn, color: "var(--accent)" }}
      disabled={savedName === key}
      data-testid={testId}
      onClick={async () => {
        await onSave({ ...emptyParty(), nameEn: name.trim(), addressEn: address.trim() }, role);
        setSavedName(key);
      }}
    >
      {savedName === key ? "✓ У довіднику" : "＋ У довідник"}
    </button>
  );
}

export function InvoiceForm({ data, onChange, parties, products, onSaveProduct, onSaveParty, templates, onSuggestNumber }: Props) {
  const set = <K extends keyof InvoiceData>(k: K, v: InvoiceData[K]) => onChange({ ...data, [k]: v });
  const setItem = (i: number, patch: Partial<InvoiceItem>) => set("items", data.items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const setBatch = (i: number, patch: Partial<Batch>) => set("batches", data.batches.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const total = itemsTotal(data.items);
  const bt = batchTotals(data.batches);
  const itemNames = [...new Set(data.items.map((i) => i.nameEn).filter(Boolean))];

  return (
    <div>
      <Section title="Основне" testId="invoice-main">
        <Grid cols="1fr 0.8fr 0.6fr">
          <div style={{ display: "flex", gap: 6, alignItems: "end" }}>
            <Field label="Номер інвойсу" value={data.number} onChange={(v) => set("number", v)} testId="invoice-number" />
            <button type="button" style={{ ...smallBtn, height: 34 }} onClick={onSuggestNumber} title="Наступний номер після останнього інвойсу" data-testid="invoice-next-number">
              +1
            </button>
          </div>
          <Field label="Дата" type="date" value={data.date} onChange={(v) => set("date", v)} />
          <Select
            label="Валюта"
            value={data.currency}
            options={[
              { value: "USD", label: "USD" },
              { value: "EUR", label: "EUR" },
            ]}
            onChange={(v) => set("currency", v)}
          />
        </Grid>
        <Field
          label="Contract No"
          value={data.contractRef}
          onChange={(v) => set("contractRef", v)}
          placeholder="31072026/PNS dated July 31, 2026"
          hint="Як друкується в інвойсі; для додатку: «APPENDIX No. 21 dated … TO THE CONTRACT No. …»"
          testId="invoice-contract-ref"
        />
      </Section>

      <Section
        title="Одержувач і відправник"
        testId="invoice-parties"
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>To:</span>
          <PartyPick
            label="Обрати покупця…"
            parties={parties.filter((p) => p.role === "buyer" || p.role === "consignee")}
            onPick={(p) => onChange({ ...data, toName: p.nameEn || p.nameUk, toAddress: p.addressEn })}
            onNew={() => onChange({ ...data, toName: "", toAddress: "" })}
            testId="invoice-to-pick"
          />
          <SaveToDirectory name={data.toName} address={data.toAddress} role="buyer" parties={parties} onSave={onSaveParty} testId="invoice-to-save" />
        </div>
        <Pair>
          <Field label="Назва" value={data.toName} onChange={(v) => set("toName", v)} />
          <Area label="Адреса" rows={2} value={data.toAddress} onChange={(v) => set("toAddress", v)} />
        </Pair>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>Consignor:</span>
          <PartyPick
            label="Обрати відправника…"
            parties={parties.filter((p) => p.role === "consignor" || p.role === "seller")}
            onPick={(p) => onChange({ ...data, consignorName: p.nameEn || p.nameUk, consignorAddress: p.addressEn })}
            onNew={() => onChange({ ...data, consignorName: "", consignorAddress: "" })}
          />
          <SaveToDirectory name={data.consignorName} address={data.consignorAddress} role="consignor" parties={parties} onSave={onSaveParty} />
        </div>
        <Pair>
          <Field label="Назва" value={data.consignorName} onChange={(v) => set("consignorName", v)} />
          <Area label="Адреса" rows={2} value={data.consignorAddress} onChange={(v) => set("consignorAddress", v)} />
        </Pair>
      </Section>

      <Section title="Умови" testId="invoice-terms">
        <Grid cols="0.7fr 0.6fr 1.4fr">
          <Select label="Інкотермс" value={data.incoterm} options={INCOTERMS.map((t) => ({ value: t, label: t }))} onChange={(v) => set("incoterm", v)} />
          <Select label="Редакція" value={data.incoYear} options={["2020", "2010"].map((y) => ({ value: y, label: y }))} onChange={(v) => set("incoYear", v)} />
          <Field label="Місце поставки (EN)" value={data.incoPlaceEn} onChange={(v) => set("incoPlaceEn", v)} />
        </Grid>
        <Grid cols="1fr 1fr">
          <Field label="Country of origin" value={data.originEn} onChange={(v) => set("originEn", v)} placeholder="з товарів, якщо порожньо" />
          <Field label="Pallets (пакувальний лист)" value={data.pallets} onChange={(v) => set("pallets", v)} placeholder="2 pallets" />
        </Grid>
        <Check label="Печатка продавця на обох сторінках" checked={data.stamp} onChange={(v) => set("stamp", v)} testId="invoice-stamp" />
        <TemplateSelect kind="invoice" value={data.templateId} templates={templates} onChange={(v) => set("templateId", v)} />
      </Section>

      <Section
        title="Товари (INVOICE)"
        testId="invoice-items"
        aside={
          <span style={{ fontSize: 13, fontWeight: 700 }} data-testid="invoice-total">
            Разом: {fmtMoney(total)} {data.currency}
          </span>
        }
      >
        {data.items.map((it, i) => (
          <div key={i} data-testid="invoice-item" style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>Товар №{i + 1}</span>
              <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700 }}>
                {fmtMoney(lineTotal(it.qty, it.price))} {data.currency}
              </span>
              <button type="button" style={{ ...smallBtn, color: "var(--err)" }} onClick={() => set("items", data.items.filter((_, j) => j !== i))} aria-label={`Видалити товар ${i + 1}`}>
                ×
              </button>
            </div>
            <Grid cols="1.4fr 1fr">
              <Field label="Name of the Goods" value={it.nameEn} onChange={(v) => setItem(i, { nameEn: v })} />
              <Field label="Українська реєстрація" value={it.reg} onChange={(v) => setItem(i, { reg: v })} />
            </Grid>
            <Grid cols="1.4fr 0.5fr 0.8fr 0.8fr">
              <Field label="Name of the Manufacturer" value={it.manufacturer} onChange={(v) => setItem(i, { manufacturer: v })} />
              <Select label="Одиниця" value={it.unit ?? "kg"} options={UNIT_OPTIONS} onChange={(v: Unit) => setItem(i, { unit: v })} />
              <NumField label={`Quantity, ${unitLabel(it.unit ?? "kg")}`} value={it.qty} onChange={(v) => setItem(i, { qty: v })} />
              <NumField label={`Price, ${data.currency}`} value={it.price} onChange={(v) => setItem(i, { price: v })} />
            </Grid>
          </div>
        ))}
        <ItemPicker
          products={products}
          onPick={(p) =>
            set("items", [
              ...data.items,
              { nameEn: p.nameEn, reg: p.reg, manufacturer: p.countryEn ? `${p.manufacturer}, ${p.countryEn}` : p.manufacturer, countryEn: p.countryEn, unit: p.unit ?? "kg", qty: 0, price: 0 },
            ])
          }
          onBlank={() => set("items", [...data.items, { nameEn: "", reg: "", manufacturer: "", countryEn: "", unit: "kg", qty: 0, price: 0 }])}
        />
        {data.items.some((it) => it.nameEn.trim() && !products.some((p) => p.nameEn === it.nameEn)) ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            Нового товару ще немає в каталозі —{" "}
            <button
              type="button"
              style={{ ...smallBtn, height: 24, color: "var(--accent)" }}
              onClick={async () => {
                for (const it of data.items.filter((x) => x.nameEn.trim() && !products.some((p) => p.nameEn === x.nameEn))) {
                  await onSaveProduct({ nameEn: it.nameEn, nameUk: "", hs: "", reg: it.reg, manufacturer: it.manufacturer, countryEn: it.countryEn, countryUk: "", unit: it.unit ?? "kg" });
                }
              }}
            >
              додати в каталог
            </button>
          </div>
        ) : null}
      </Section>

      <Section
        title="Партії (PACKING LIST)"
        testId="invoice-batches"
        aside={
          <span style={{ fontSize: 12.5, color: "var(--muted)" }} data-testid="batch-totals">
            нетто {fmtNum(bt.net)} · брутто {fmtNum(bt.gross)} · місць {fmtNum(bt.packages)}
          </span>
        }
      >
        {data.batches.map((b, i) => (
          <div key={i} data-testid="invoice-batch" style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>Партія №{i + 1}</span>
              <button type="button" style={{ ...smallBtn, marginLeft: "auto" }} onClick={() => set("batches", [...data.batches.slice(0, i + 1), { ...b, batch: "" }, ...data.batches.slice(i + 1)])}>
                Дублювати
              </button>
              <button type="button" style={{ ...smallBtn, color: "var(--err)" }} onClick={() => set("batches", data.batches.filter((_, j) => j !== i))} aria-label={`Видалити партію ${i + 1}`}>
                ×
              </button>
            </div>
            <Grid cols="1.3fr 1fr 1fr">
              <label style={{ display: "block", minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 11.5, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>Товар</span>
                <input className="input" list="docb-item-names" style={{ width: "100%", height: 34, fontSize: 13.5, padding: "0 10px" }} value={b.nameEn} onChange={(e) => setBatch(i, { nameEn: e.target.value })} />
              </label>
              <Field label="Batch Nr." value={b.batch} onChange={(v) => setBatch(i, { batch: v })} testId="batch-nr" />
              <Field label="Реєстрація (під назвою)" value={b.reg} onChange={(v) => setBatch(i, { reg: v })} />
            </Grid>
            <Grid cols="0.8fr 0.8fr 1.4fr 0.6fr">
              <NumField label="Net, kg" value={b.net} onChange={(v) => setBatch(i, { net: v })} />
              <NumField label="Gross, kg" value={b.gross} onChange={(v) => setBatch(i, { gross: v })} testId="batch-gross" />
              <Field label="Quantity, packages" value={b.packages} onChange={(v) => setBatch(i, { packages: v })} placeholder="10 X 50 KG BALES" />
              <NumField label="Місць" value={b.packagesCount} onChange={(v) => setBatch(i, { packagesCount: v })} />
            </Grid>
          </div>
        ))}
        <datalist id="docb-item-names">
          {itemNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={{ ...smallBtn, height: 32 }} onClick={() => set("batches", [...data.batches, emptyBatch(data.items[0])])} data-testid="add-batch">
            ＋ Партія
          </button>
          {data.items.length ? (
            <button type="button" style={{ ...smallBtn, height: 32 }} onClick={() => set("batches", data.items.map((it) => emptyBatch(it)))} title="По одній партії на кожен товар, нетто = кількість">
              Партії з товарів
            </button>
          ) : null}
        </div>
      </Section>
    </div>
  );
}
