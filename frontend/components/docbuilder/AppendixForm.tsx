"use client";

// Додаток (специфікація) до контракту: a delivery under a long contract —
// «ANNEX No. 21 dated … TO THE CONTRACT No. … dated …».
import type { AppendixData, DirectoryParty, DirectoryProduct, Party, Product, TemplateInfo } from "@/lib/docbuilder/model";
import { emptyParty } from "@/lib/docbuilder/model";
import { Check, Field, Grid, Pair, Section, Select } from "./fields";
import { PartyEditor } from "./PartyEditor";
import { SpecSection, TemplateSelect, TermsSection } from "./sections";

interface Props {
  data: AppendixData;
  onChange: (d: AppendixData) => void;
  parties: DirectoryParty[];
  products: DirectoryProduct[];
  templates: TemplateInfo[];
  linkedContract: string | null;
  onSaveParty: (p: Party, role: DirectoryParty["role"]) => Promise<void>;
  onSaveProduct: (p: Product) => Promise<void>;
}

export function AppendixForm({ data, onChange, parties, products, templates, linkedContract, onSaveParty, onSaveProduct }: Props) {
  const set = <K extends keyof AppendixData>(k: K, v: AppendixData[K]) => onChange({ ...data, [k]: v });
  return (
    <div>
      <Section title="Додаток" testId="appendix-main">
        {linkedContract ? <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Повʼязано з контрактом {linkedContract} — сторони й умови взято з нього.</div> : null}
        <Grid cols="0.6fr 1fr 0.8fr">
          <Field label="№ додатку" value={data.number} onChange={(v) => set("number", v)} testId="appendix-number" />
          <Field label="Дата додатку" type="date" value={data.date} onChange={(v) => set("date", v)} />
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
        <Grid cols="1.2fr 1fr">
          <Field label="До контракту №" value={data.contractNumber} onChange={(v) => set("contractNumber", v)} testId="appendix-contract-number" />
          <Field label="Дата контракту" type="date" value={data.contractDate} onChange={(v) => set("contractDate", v)} />
        </Grid>
        <Pair>
          <Field label="Місце підписання (EN)" value={data.signPlaceEn} onChange={(v) => set("signPlaceEn", v)} />
          <Field label="Місце підписання (UA)" value={data.signPlaceUk} onChange={(v) => set("signPlaceUk", v)} />
        </Pair>
        <TemplateSelect kind="appendix" value={data.templateId} templates={templates} onChange={(v) => set("templateId", v)} />
      </Section>

      <Section title="Сторони" testId="appendix-parties" defaultOpen={!linkedContract}>
        <PartyEditor title="Продавець" party={data.seller} onChange={(p) => set("seller", p)} directory={parties} roles={["seller"]} onSaveToDirectory={(p) => onSaveParty(p, "seller")} testId="party-seller" />
        <PartyEditor title="Покупець" party={data.buyer} onChange={(p) => set("buyer", p)} directory={parties} roles={["buyer"]} onSaveToDirectory={(p) => onSaveParty(p, "buyer")} testId="party-buyer" />
        <Check label="Відправника буде повідомлено додатково" checked={data.consignor === null} onChange={(v) => set("consignor", v ? null : emptyParty())} />
        {data.consignor ? (
          <PartyEditor title="Відправник" party={data.consignor} onChange={(p) => set("consignor", p)} directory={parties} roles={["consignor", "seller"]} onSaveToDirectory={(p) => onSaveParty(p, "consignor")} show={{}} />
        ) : null}
      </Section>

      <TermsSection value={data} onChange={(patch) => onChange({ ...data, ...patch })} />

      <SpecSection
        title="Специфікація додатку"
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
