"use client";

// Sections shared by the contract and the annex: the specification (goods with
// units), delivery + payment terms, and the template picker.
import type { ContractItem, Currency, DirectoryProduct, DocKind, PaymentType, Product, TemplateInfo, Unit } from "@/lib/docbuilder/model";
import { INCOTERMS, PAYMENT_OPTIONS, UNIT_OPTIONS, emptyProduct, fmtMoney, itemFromProduct, itemsTotal, lineTotal, unitLabel } from "@/lib/docbuilder/model";
import { Check, Field, Grid, NumField, Pair, Section, Select, smallBtn } from "./fields";
import { ItemPicker } from "./ItemPicker";

export function SpecSection({
  items,
  currency,
  showReg,
  onItems,
  onShowReg,
  products,
  onSaveProduct,
  title = "Специфікація (Додаток №1)",
}: {
  items: ContractItem[];
  currency: Currency;
  showReg: boolean;
  onItems: (items: ContractItem[]) => void;
  onShowReg: (v: boolean) => void;
  products: DirectoryProduct[];
  onSaveProduct: (p: Product) => Promise<void>;
  title?: string;
}) {
  const total = itemsTotal(items);
  const setItem = (i: number, patch: Partial<ContractItem>) => onItems(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  return (
    <Section
      title={title}
      testId="contract-items"
      aside={
        <span style={{ fontSize: 13, fontWeight: 700 }} data-testid="contract-total">
          Разом: {fmtMoney(total)} {currency}
        </span>
      }
    >
      <Check label="Українська реєстрація (фарм. субстанції): рядок у маркуванні та номер у специфікації" checked={showReg} onChange={onShowReg} testId="show-reg" />
      {items.map((it, i) => (
        <div key={i} data-testid="contract-item" style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>Товар №{i + 1}</span>
            <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700 }}>
              {fmtMoney(lineTotal(it.qty, it.price))} {currency}
            </span>
            {it.nameEn.trim() && !products.some((p) => p.nameEn === it.nameEn) ? (
              <button type="button" style={{ ...smallBtn, color: "var(--accent)" }} onClick={() => onSaveProduct(it)}>
                ＋ У каталог
              </button>
            ) : null}
            <button type="button" style={{ ...smallBtn, color: "var(--err)" }} onClick={() => onItems(items.filter((_, j) => j !== i))} aria-label={`Видалити товар ${i + 1}`}>
              ×
            </button>
          </div>
          <Pair>
            <Field label="Назва (EN)" value={it.nameEn} onChange={(v) => setItem(i, { nameEn: v })} testId="item-name-en" />
            <Field label="Назва (UA)" value={it.nameUk} onChange={(v) => setItem(i, { nameUk: v })} />
          </Pair>
          <Grid cols={showReg ? "0.7fr 1.3fr" : "0.7fr"}>
            <Field label="Код УКТ ЗЕД (HS)" value={it.hs} onChange={(v) => setItem(i, { hs: v.replace(/[^\d]/g, "").slice(0, 10) })} placeholder="10 цифр" />
            {showReg ? <Field label="Українська реєстрація" value={it.reg} onChange={(v) => setItem(i, { reg: v })} placeholder="UA/18432/01/01 …" /> : null}
          </Grid>
          <Grid cols="1.4fr 0.8fr 0.8fr">
            <Field label="Виробник" value={it.manufacturer} onChange={(v) => setItem(i, { manufacturer: v })} />
            <Field label="Країна (EN)" value={it.countryEn} onChange={(v) => setItem(i, { countryEn: v })} placeholder="India" />
            <Field label="Країна (UA)" value={it.countryUk} onChange={(v) => setItem(i, { countryUk: v })} placeholder="Індія" />
          </Grid>
          <Grid cols="0.6fr 1fr 1fr 0.8fr">
            <Select label="Одиниця" value={it.unit ?? "kg"} options={UNIT_OPTIONS} onChange={(v: Unit) => setItem(i, { unit: v })} testId="item-unit" />
            <NumField label={`Кількість, ${unitLabel(it.unit ?? "kg")}`} value={it.qty} onChange={(v) => setItem(i, { qty: v })} testId="item-qty" />
            <NumField label={`Ціна за ${unitLabel(it.unit ?? "kg")}, ${currency}`} value={it.price} onChange={(v) => setItem(i, { price: v })} testId="item-price" />
            <div style={{ fontSize: 12, color: "var(--muted)", paddingBottom: 9 }}>= {fmtMoney(lineTotal(it.qty, it.price))}</div>
          </Grid>
        </div>
      ))}
      <ItemPicker products={products} onPick={(p) => onItems([...items, itemFromProduct(p)])} onBlank={() => onItems([...items, itemFromProduct(emptyProduct())])} />
    </Section>
  );
}

export interface TermsValue {
  currency: Currency;
  incoterm: string;
  incoYear: string;
  incoPlaceEn: string;
  incoPlaceUk: string;
  deliveryDays: number;
  paymentType: PaymentType;
  paymentDays: number;
  prepayDays: number;
  prepayPercent: number;
}

export function TermsSection({ value, onChange }: { value: TermsValue; onChange: (patch: Partial<TermsValue>) => void }) {
  const p = value.paymentType;
  return (
    <Section title="Умови поставки та оплати" testId="contract-terms">
      <Grid cols="0.8fr 0.6fr 1fr">
        <Select label="Інкотермс" value={value.incoterm} options={INCOTERMS.map((t) => ({ value: t, label: t }))} onChange={(v) => onChange({ incoterm: v })} />
        <Select label="Редакція" value={value.incoYear} options={["2020", "2010"].map((y) => ({ value: y, label: y }))} onChange={(v) => onChange({ incoYear: v })} />
        <NumField label="Строк поставки, днів" value={value.deliveryDays} onChange={(v) => onChange({ deliveryDays: Math.round(v) })} align="left" />
      </Grid>
      <Pair>
        <Field label="Місце поставки (EN)" value={value.incoPlaceEn} onChange={(v) => onChange({ incoPlaceEn: v })} placeholder="Bila Tserkva, Ukraine" testId="inco-place-en" />
        <Field label="Місце поставки (UA)" value={value.incoPlaceUk} onChange={(v) => onChange({ incoPlaceUk: v })} placeholder="Біла Церква, Україна" />
      </Pair>
      <Grid cols={p === "prepay_part" ? "1.4fr 0.6fr 0.7fr 0.8fr" : p === "deferred" ? "1.4fr 0.8fr" : "1.4fr 0.8fr"}>
        <Select label="Умови оплати" value={p} options={PAYMENT_OPTIONS} onChange={(v) => onChange({ paymentType: v })} testId="payment-type" />
        {p === "prepay_part" ? <NumField label="Передоплата, %" value={value.prepayPercent} onChange={(v) => onChange({ prepayPercent: Math.min(99, Math.max(1, Math.round(v))) })} align="left" /> : null}
        {p !== "deferred" ? (
          <NumField label={p === "lc" ? "Відкрити акредитив за, днів" : "Передоплата за, днів"} value={value.prepayDays} onChange={(v) => onChange({ prepayDays: Math.round(v) })} align="left" />
        ) : null}
        {p === "deferred" || p === "prepay_part" ? (
          <NumField label={p === "deferred" ? "Оплата після поставки, днів" : "Решта після поставки, днів"} value={value.paymentDays} onChange={(v) => onChange({ paymentDays: Math.round(v) })} align="left" />
        ) : null}
      </Grid>
    </Section>
  );
}

export function TemplateSelect({ kind, value, templates, onChange }: { kind: DocKind; value: string | null; templates: TemplateInfo[]; onChange: (id: string | null) => void }) {
  const list = templates.filter((t) => t.kind === kind);
  if (!list.length) return null;
  return (
    <Select
      label="Шаблон Word"
      value={value ?? ""}
      options={[{ value: "", label: "Стандартний (з документів команди)" }, ...list.map((t) => ({ value: t.id, label: t.name }))]}
      onChange={(v) => onChange(v || null)}
      testId="template-select"
    />
  );
}
