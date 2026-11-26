"use client";

// Form primitives for the document builder: a labelled input, a bilingual
// EN | UA pair, a collapsible section. Inline styles + the shared .input/.btn
// classes, like the rest of the app.
import { useState, type ReactNode } from "react";
import { LnChevronDown, LnChevronRight } from "../ui/LineIcons";
import { Select as UiSelect } from "@/components/ui/Select";
import { DateInput } from "@/components/ui/DateInput";

export const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--muted)",
  marginBottom: 4,
  letterSpacing: 0.1,
};

const inputStyle: React.CSSProperties = { width: "100%", height: 34, fontSize: 13.5, padding: "0 10px" };
const areaStyle: React.CSSProperties = { width: "100%", fontSize: 13, padding: "8px 10px", lineHeight: 1.45, resize: "vertical", fontFamily: "inherit" };

export function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  testId,
  type = "text",
  width,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  testId?: string;
  type?: "text" | "date" | "number";
  width?: number | string;
}) {
  return (
    <label style={{ display: "block", minWidth: 0, width }}>
      <span style={labelStyle}>{label}</span>
      {type === "date" ? (
        <DateInput type="date" className="input" style={inputStyle} value={String(value)} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
      ) : (
      <input
        className="input"
        style={inputStyle}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        step={type === "number" ? "any" : undefined}
        min={type === "number" ? 0 : undefined}
      />
      )}
      {hint ? <span style={{ display: "block", fontSize: 11, color: "var(--faint)", marginTop: 3 }}>{hint}</span> : null}
    </label>
  );
}

export function Area({
  label,
  value,
  onChange,
  rows = 4,
  placeholder,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <label style={{ display: "block", minWidth: 0 }}>
      <span style={labelStyle}>{label}</span>
      <textarea
        className="input"
        style={areaStyle}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </label>
  );
}

/** Two columns: English on the left, Ukrainian on the right — like the contract itself. */
export function Pair({ children }: { children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>{children}</div>;
}

export function Grid({ cols, children }: { cols: string; children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "end" }}>{children}</div>;
}

export function Section({
  title,
  aside,
  children,
  defaultOpen = true,
  testId,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      data-testid={testId}
      style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", marginBottom: 12 }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px" }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text)", font: "inherit", fontSize: 14, fontWeight: 700 }}
          aria-expanded={open}
        >
          {open ? <LnChevronDown size={15} /> : <LnChevronRight size={15} />}
          {title}
        </button>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>{aside}</div>
      </header>
      {open ? <div style={{ padding: "0 14px 14px", display: "grid", gap: 10 }}>{children}</div> : null}
    </section>
  );
}

export function Check({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      {label}
    </label>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  testId?: string;
}) {
  return (
    <label style={{ display: "block", minWidth: 0 }}>
      <span style={labelStyle}>{label}</span>
      <UiSelect className="input" style={inputStyle} value={value} onChange={(e) => onChange(e.target.value as T)} data-testid={testId}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </UiSelect>
    </label>
  );
}

export const smallBtn: React.CSSProperties = {
  height: 28,
  padding: "0 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const num = (v: string): number => {
  const n = Number(v.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * A number typed the Ukrainian way («1,73», «2 200»). Keeps the raw text while
 * the user types (so «1,» survives) and resyncs when the value changes outside.
 */
export function NumField({
  label,
  value,
  onChange,
  testId,
  align = "right",
}: {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  testId?: string;
  align?: "left" | "right";
}) {
  const [text, setText] = useState(value ? String(value).replace(".", ",") : "");
  const shown = num(text) === value ? text : value ? String(value).replace(".", ",") : "";
  const input = (
    <input
      className="input"
      style={{ ...inputStyle, textAlign: align }}
      inputMode="decimal"
      value={shown}
      placeholder="0"
      data-testid={testId}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d.,\s]/g, "");
        setText(t);
        onChange(num(t));
      }}
    />
  );
  if (!label) return input;
  return (
    <label style={{ display: "block", minWidth: 0 }}>
      <span style={labelStyle}>{label}</span>
      {input}
    </label>
  );
}
