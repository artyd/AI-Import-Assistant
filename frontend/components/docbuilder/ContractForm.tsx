"use client";

// Контракт + Специфікація: the variable parts of the team's bilingual contract.
// Everything else (clauses 1–13) is the template's fixed text.
import type { ContractData, DirectoryParty, DirectoryProduct, Party, Product, TemplateInfo } from "@/lib/docbuilder/model";
import { GOODS_PRESETS, contractNumber, emptyParty, isAutoNumber, snapshot } from "@/lib/docbuilder/model";
import { Check, Field, Grid, Pair, Section, Select, smallBtn } from "./fields";
import { PartyEditor } from "./PartyEditor";
import { SpecSection, TemplateSelect, TermsSection } from "./sections";

interface Props {
  data: ContractData;
  onChange: (d: ContractData) => void;
  parties: DirectoryParty[];
  products: DirectoryProduct[];
  templates: TemplateInfo[];
  onSaveParty: (p: Party, role: DirectoryParty["role"]) => Promise<void>;
  onSaveProduct: (p: Product) => Promise<void>;
}

export function ContractForm({ data, onChange, parties, products, templates, onSaveParty, onSaveProduct }: Props) {
  const set = <K extends keyof ContractData>(k: K, v: ContractData[K]) => onChange({ ...data, [k]: v });
  const goodsPreset = GOODS_PRESETS.find((g) => g.en === data.goodsEn)?.en ?? "custom";

  return (
    <div>
      <Section title="Основне" testId="contract-main">
        <Grid cols="1.2fr 1fr 0.8fr">
          <div style={{ display: "flex", gap: 6, alignItems: "end" }}>
            <Field label="Номер контракту" value={data.number} onChange={(v) => set("number", v)} testId="contract-number" />
            <button type="button" style={{ ...smallBtn, height: 34 }} title="Дата + суфікс покупця" onClick={() => set("number", contractNumber(data.date, data.buyer.code))}>
              Авто
            </button>
          </div>
          <Field
            label="Дата"
            type="date"
            value={data.date}
            onChange={(v) => onChange({ ...data, date: v, number: isAutoNumber(data.number) ? contractNumber(v, data.buyer.code) : data.number })}
            testId="contract-date"
          />
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
        <Pair>
          <Field label="Місце підписання (EN)" value={data.signPlaceEn} onChange={(v) => set("signPlaceEn", v)} />
          <Field label="Місце підписання (UA)" value={data.signPlaceUk} onChange={(v) => set("signPlaceUk", v)} />
        </Pair>
        <Grid cols="1fr 1fr 1fr">
          <Select
            label="Предмет (п. 1.1)"
            value={goodsPreset}
            options={[...GOODS_PRESETS.map((g) => ({ value: g.en, label: g.label })), { value: "custom", label: "інше…" }]}
            onChange={(v) => {
              const g = GOODS_PRESETS.find((x) => x.en === v);
              onChange(g ? { ...data, goodsEn: g.en, goodsUk: g.uk } : { ...data, goodsEn: "", goodsUk: "" });
            }}
          />
          <Field label="Товар (EN)" value={data.goodsEn} onChange={(v) => set("goodsEn", v)} />
          <Field label="Товар (UA)" value={data.goodsUk} onChange={(v) => set("goodsUk", v)} />
        </Grid>
        <TemplateSelect kind="contract" value={data.templateId} templates={templates} onChange={(v) => set("templateId", v)} />
      </Section>

      <Section title="Сторони" testId="contract-parties">
        <PartyEditor title="Продавець" party={data.seller} onChange={(p) => set("seller", p)} directory={parties} roles={["seller"]} onSaveToDirectory={(p) => onSaveParty(p, "seller")} testId="party-seller" />
        <PartyEditor
          title="Покупець"
          party={data.buyer}
          onChange={(p) => onChange({ ...data, buyer: p, number: isAutoNumber(data.number) ? contractNumber(data.date, p.code) : data.number })}
          directory={parties}
          roles={["buyer"]}
          onSaveToDirectory={(p) => onSaveParty(p, "buyer")}
          show={{ signatory: true, requisites: true, code: true }}
          testId="party-buyer"
        />
        <div style={{ borderTop: "1px dashed var(--border)", paddingTop: 10, display: "grid", gap: 8 }}>
          <Check label="Вантажоодержувач — той самий, що покупець (п. 3.3)" checked={data.consignee === null} onChange={(v) => set("consignee", v ? null : snapshot(data.buyer))} testId="consignee-same" />
          {data.consignee ? (
            <PartyEditor
              title="Вантажоодержувач"
              party={data.consignee}
              onChange={(p) => set("consignee", p)}
              directory={parties}
              roles={["consignee", "buyer"]}
              onSaveToDirectory={(p) => onSaveParty(p, "consignee")}
              show={{}}
              testId="party-consignee"
            />
          ) : null}
          <Check label="Відправника буде повідомлено додатково (п. 3.2)" checked={data.consignor === null} onChange={(v) => set("consignor", v ? null : emptyParty())} testId="consignor-later" />
          {data.consignor ? (
            <PartyEditor
              title="Відправник"
              party={data.consignor}
              onChange={(p) => set("consignor", p)}
              directory={parties}
              roles={["consignor", "seller"]}
              onSaveToDirectory={(p) => onSaveParty(p, "consignor")}
              show={{}}
              testId="party-consignor"
            />
          ) : null}
        </div>
      </Section>

      <TermsSection value={data} onChange={(patch) => onChange({ ...data, ...patch })} />

      <SpecSection
        items={data.items}
        currency={data.currency}
        showReg={data.showReg}
        onItems={(items) => set("items", items)}
        onShowReg={(v) => set("showReg", v)}
        products={products}
        onSaveProduct={onSaveProduct}
      />
    </div>
  );
}
