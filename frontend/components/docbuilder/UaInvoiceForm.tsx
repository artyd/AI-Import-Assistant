"use client";

// Видаткова накладна / Рахунок на оплату — domestic sales in hryvnias, with VAT.
import type { DirectoryParty, Party, TemplateInfo, UaInvoiceData, UaItem, UaUnit } from "@/lib/docbuilder/model";
import { UA_UNITS, fmtMoney, lineTotal, uaTotals } from "@/lib/docbuilder/model";
import { Field, Grid, NumField, Section, Select, smallBtn } from "./fields";
import { PartyEditor } from "./PartyEditor";
import { TemplateSelect } from "./sections";

interface Props {
  data: UaInvoiceData;
  onChange: (d: UaInvoiceData) => void;
  parties: DirectoryParty[];
  templates: TemplateInfo[];
  onSaveParty: (p: Party, role: DirectoryParty["role"]) => Promise<void>;
  onSuggestNumber: () => void;
}

export function UaInvoiceForm({ data, onChange, parties, templates, onSaveParty, onSuggestNumber }: Props) {
  const set = <K extends keyof UaInvoiceData>(k: K, v: UaInvoiceData[K]) => onChange({ ...data, [k]: v });
  const setItem = (i: number, patch: Partial<UaItem>) => set("items", data.items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const t = uaTotals(data);
  return (
    <div>
      <Section title="Документ" testId="ua-main">
        <Grid cols="1.2fr 0.9fr 0.9fr 0.8fr">
          <Select
            label="Тип"
            value={data.docType}
            options={[
              { value: "nakladna", label: "Видаткова накладна" },
              { value: "rahunok", label: "Рахунок на оплату" },
            ]}
            onChange={(v) => set("docType", v)}
            testId="ua-doctype"
          />
          <div style={{ display: "flex", gap: 6, alignItems: "end" }}>
            <Field label="Номер" value={data.number} onChange={(v) => set("number", v)} testId="ua-number" />
            <button type="button" style={{ ...smallBtn, height: 34 }} onClick={onSuggestNumber} title="Наступний після останнього">
              +1
            </button>
          </div>
          <Field label="Дата" type="date" value={data.date} onChange={(v) => set("date", v)} />
          <Select
            label="ПДВ"
            value={String(data.vatRate)}
            options={[
              { value: "20", label: "20%" },
              { value: "7", label: "7%" },
              { value: "0", label: "без ПДВ" },
            ]}
            onChange={(v) => set("vatRate", Number(v))}
          />
        </Grid>
        <Grid cols="1.4fr 1fr">
          <Field label="Підстава (договір)" value={data.basis} onChange={(v) => set("basis", v)} placeholder="Договір поставки № 12 від 01.10.2026" />
          <Field label="Місце складання" value={data.place} onChange={(v) => set("place", v)} />
        </Grid>
        <TemplateSelect kind="ua_invoice" value={data.templateId} templates={templates} onChange={(v) => set("templateId", v)} />
      </Section>

      <Section title="Сторони" testId="ua-parties">
        <PartyEditor title="Постачальник" party={data.seller} onChange={(p) => set("seller", p)} directory={parties} roles={["seller", "other"]} onSaveToDirectory={(p) => onSaveParty(p, "seller")} show={{ requisites: true }} testId="party-seller" />
        <PartyEditor title="Покупець" party={data.buyer} onChange={(p) => set("buyer", p)} directory={parties} roles={["buyer", "other"]} onSaveToDirectory={(p) => onSaveParty(p, "buyer")} show={{ requisites: true }} testId="party-buyer" />
        <Grid cols="1fr 1fr">
          <Field label="Від постачальника (ПІБ)" value={data.sellerSigner} onChange={(v) => set("sellerSigner", v)} placeholder="Петренко П.П." />
          <Field label="Отримав (ПІБ)" value={data.buyerSigner} onChange={(v) => set("buyerSigner", v)} />
        </Grid>
      </Section>

      <Section
        title="Товари"
        testId="ua-items"
        aside={
          <span style={{ fontSize: 13, fontWeight: 700 }} data-testid="ua-total">
            Всього: {fmtMoney(t.total)} грн{data.vatRate ? ` (ПДВ ${fmtMoney(t.vat)})` : ""}
          </span>
        }
      >
        {data.items.map((it, i) => (
          <Grid key={i} cols="2.2fr 0.7fr 0.8fr 0.9fr 0.8fr auto">
            <Field label={i === 0 ? "Найменування" : ""} value={it.name} onChange={(v) => setItem(i, { name: v })} testId="ua-item-name" />
            <Select label={i === 0 ? "Од." : ""} value={it.unit} options={UA_UNITS.map((u) => ({ value: u, label: u }))} onChange={(v: UaUnit) => setItem(i, { unit: v })} />
            <NumField label={i === 0 ? "Кількість" : undefined} value={it.qty} onChange={(v) => setItem(i, { qty: v })} testId="ua-item-qty" />
            <NumField label={i === 0 ? "Ціна без ПДВ" : undefined} value={it.price} onChange={(v) => setItem(i, { price: v })} testId="ua-item-price" />
            <div style={{ fontSize: 12.5, paddingBottom: 9, textAlign: "right" }}>{fmtMoney(lineTotal(it.qty, it.price))}</div>
            <button type="button" style={{ ...smallBtn, height: 34, color: "var(--err)" }} onClick={() => set("items", data.items.filter((_, j) => j !== i))} aria-label={`Видалити рядок ${i + 1}`}>
              ×
            </button>
          </Grid>
        ))}
        <div>
          <button type="button" className="btn btn-primary" style={{ height: 32, fontSize: 13 }} onClick={() => set("items", [...data.items, { name: "", unit: "кг", qty: 0, price: 0 }])} data-testid="ua-add-item">
            ＋ Рядок
          </button>
        </div>
      </Section>
    </div>
  );
}
