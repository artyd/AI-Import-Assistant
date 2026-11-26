"use client";

// Контракт + Специфікація: the variable parts of the team's bilingual contract.
// Everything else (clauses 1–13) is the template's fixed text.
import type { ContractData, ContractItem, DirectoryParty, DirectoryProduct, Party, Product } from "@/lib/docbuilder/model";
import { GOODS_PRESETS, INCOTERMS, contractNumber, emptyParty, fmtMoney, isAutoNumber, itemFromProduct, itemsTotal, lineTotal, snapshot } from "@/lib/docbuilder/model";
import { Check, Field, Grid, NumField, Pair, Section, Select, smallBtn } from "./fields";
import { PartyEditor } from "./PartyEditor";
import { ItemPicker } from "./ItemPicker";

interface Props {
  data: ContractData;
  onChange: (d: ContractData) => void;
  parties: DirectoryParty[];
  products: DirectoryProduct[];
  onSaveParty: (p: Party, role: DirectoryParty["role"]) => Promise<void>;
  onSaveProduct: (p: Product) => Promise<void>;
}

export function ContractForm({ data, onChange, parties, products, onSaveParty, onSaveProduct }: Props) {
  const set = <K extends keyof ContractData>(k: K, v: ContractData[K]) => onChange({ ...data, [k]: v });
  const total = itemsTotal(data.items);
  const goodsPreset = GOODS_PRESETS.find((g) => g.en === data.goodsEn)?.en ?? "custom";

  const setItem = (i: number, patch: Partial<ContractItem>) =>
    set(
      "items",
      data.items.map((it, j) => (j === i ? { ...it, ...patch } : it)),
    );

  return (
    <div>
      <Section title="Основне" testId="contract-main">
        <Grid cols="1.2fr 1fr 0.8fr">
          <div style={{ display: "flex", gap: 6, alignItems: "end" }}>
            <Field label="Номер контракту" value={data.number} onChange={(v) => set("number", v)} testId="contract-number" />
            <button
              type="button"
              style={{ ...smallBtn, height: 34 }}
              title="Дата + суфікс покупця"
              onClick={() => set("number", contractNumber(data.date, data.buyer.code))}
            >
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
      </Section>

      <Section title="Сторони" testId="contract-parties">
        <PartyEditor
          title="Продавець"
          party={data.seller}
          onChange={(p) => set("seller", p)}
          directory={parties}
          roles={["seller"]}
          onSaveToDirectory={(p) => onSaveParty(p, "seller")}
          testId="party-seller"
        />
        <PartyEditor
          title="Покупець"
          party={data.buyer}
          onChange={(p) =>
            onChange({ ...data, buyer: p, number: isAutoNumber(data.number) ? contractNumber(data.date, p.code) : data.number })
          }
          directory={parties}
          roles={["buyer"]}
          onSaveToDirectory={(p) => onSaveParty(p, "buyer")}
          show={{ signatory: true, requisites: true, code: true }}
          testId="party-buyer"
        />
        <div style={{ borderTop: "1px dashed var(--border)", paddingTop: 10, display: "grid", gap: 8 }}>
          <Check
            label="Вантажоодержувач — той самий, що покупець (п. 3.3)"
            checked={data.consignee === null}
            onChange={(v) => set("consignee", v ? null : snapshot(data.buyer))}
            testId="consignee-same"
          />
          {data.consignee ? (
            <PartyEditor
              title="Вантажоодержувач"
              party={data.consignee}
              onChange={(p) => set("consignee", p)}
              directory={parties}
              roles={["buyer", "other"]}
              show={{}}
            />
          ) : null}
          <Check
            label="Відправника буде повідомлено додатково (п. 3.2)"
            checked={data.consignor === null}
            onChange={(v) => set("consignor", v ? null : emptyParty())}
            testId="consignor-later"
          />
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

      <Section title="Умови поставки та оплати" testId="contract-terms">
        <Grid cols="0.8fr 0.6fr 1fr 1fr">
          <Select label="Інкотермс" value={data.incoterm} options={INCOTERMS.map((t) => ({ value: t, label: t }))} onChange={(v) => set("incoterm", v)} />
          <Select
            label="Редакція"
            value={data.incoYear}
            options={["2020", "2010"].map((y) => ({ value: y, label: y }))}
            onChange={(v) => set("incoYear", v)}
          />
          <NumField label="Строк поставки, днів" value={data.deliveryDays} onChange={(v) => set("deliveryDays", Math.round(v))} align="left" />
          <NumField label="Оплата протягом, днів" value={data.paymentDays} onChange={(v) => set("paymentDays", Math.round(v))} align="left" />
        </Grid>
        <Pair>
          <Field label="Місце поставки (EN)" value={data.incoPlaceEn} onChange={(v) => set("incoPlaceEn", v)} placeholder="Bila Tserkva, Ukraine" testId="inco-place-en" />
          <Field label="Місце поставки (UA)" value={data.incoPlaceUk} onChange={(v) => set("incoPlaceUk", v)} placeholder="Біла Церква, Україна" />
        </Pair>
      </Section>

      <Section
        title="Специфікація (Додаток №1)"
        testId="contract-items"
        aside={
          <span style={{ fontSize: 13, fontWeight: 700 }} data-testid="contract-total">
            Разом: {fmtMoney(total)} {data.currency}
          </span>
        }
      >
        <Check
          label="Українська реєстрація (фарм. субстанції): рядок у п. 6.4 і номер у специфікації"
          checked={data.showReg}
          onChange={(v) => set("showReg", v)}
          testId="show-reg"
        />
        {data.items.map((it, i) => (
          <div key={i} data-testid="contract-item" style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>Товар №{i + 1}</span>
              <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700 }}>
                {fmtMoney(lineTotal(it.qty, it.price))} {data.currency}
              </span>
              {it.nameEn.trim() && !products.some((p) => p.nameEn === it.nameEn) ? (
                <button type="button" style={{ ...smallBtn, color: "var(--accent)" }} onClick={() => onSaveProduct(it)}>
                  ＋ У каталог
                </button>
              ) : null}
              <button
                type="button"
                style={{ ...smallBtn, color: "var(--err)" }}
                onClick={() => set("items", data.items.filter((_, j) => j !== i))}
                aria-label={`Видалити товар ${i + 1}`}
              >
                ×
              </button>
            </div>
            <Pair>
              <Field label="Назва (EN)" value={it.nameEn} onChange={(v) => setItem(i, { nameEn: v })} testId="item-name-en" />
              <Field label="Назва (UA)" value={it.nameUk} onChange={(v) => setItem(i, { nameUk: v })} />
            </Pair>
            <Grid cols={data.showReg ? "0.7fr 1.3fr" : "0.7fr"}>
              <Field label="Код УКТ ЗЕД (HS)" value={it.hs} onChange={(v) => setItem(i, { hs: v })} />
              {data.showReg ? <Field label="Українська реєстрація" value={it.reg} onChange={(v) => setItem(i, { reg: v })} placeholder="UA/18432/01/01 …" /> : null}
            </Grid>
            <Grid cols="1.4fr 0.8fr 0.8fr">
              <Field label="Виробник" value={it.manufacturer} onChange={(v) => setItem(i, { manufacturer: v })} />
              <Field label="Країна (EN)" value={it.countryEn} onChange={(v) => setItem(i, { countryEn: v })} placeholder="India" />
              <Field label="Країна (UA)" value={it.countryUk} onChange={(v) => setItem(i, { countryUk: v })} placeholder="Індія" />
            </Grid>
            <Grid cols="1fr 1fr 1fr">
              <NumField label="Кількість, кг" value={it.qty} onChange={(v) => setItem(i, { qty: v })} testId="item-qty" />
              <NumField label={`Ціна за кг, ${data.currency}`} value={it.price} onChange={(v) => setItem(i, { price: v })} testId="item-price" />
              <div style={{ fontSize: 12, color: "var(--muted)", paddingBottom: 9 }}>= {fmtMoney(lineTotal(it.qty, it.price))}</div>
            </Grid>
          </div>
        ))}
        <ItemPicker
          products={products}
          onPick={(p) => set("items", [...data.items, itemFromProduct(p)])}
          onBlank={() => set("items", [...data.items, itemFromProduct({ nameEn: "", nameUk: "", hs: "", reg: "", manufacturer: "", countryEn: "", countryUk: "" })])}
        />
      </Section>
    </div>
  );
}
