"use client";

// The document-type pickers of the builder: «＋ Новий документ» (what to create)
// and the list filter (which kind to show). One styled dropdown each — a card
// per kind with its colour, name and a one-line hint.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DocKind } from "@/lib/docbuilder/model";

export const KIND_COLOR: Record<DocKind, string> = {
  contract: "var(--accent)",
  appendix: "#8b5cf6",
  invoice: "var(--ok)",
  ua_invoice: "var(--warn)",
};

const KIND_BADGE: Record<DocKind, string> = { contract: "К", appendix: "Д", invoice: "І", ua_invoice: "Н" };

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open, close]);
  return ref;
}

const panel: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  top: "calc(100% + 6px)",
  zIndex: 40,
  background: "var(--menu)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  boxShadow: "var(--shadow)",
  padding: 6,
  display: "grid",
  gap: 2,
};

export function KindBadge({ kind, size = 30, children }: { kind?: DocKind; size?: number; children?: ReactNode }) {
  const color = kind ? KIND_COLOR[kind] : "var(--muted)";
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: "none",
        borderRadius: 9,
        display: "grid",
        placeItems: "center",
        fontSize: size > 24 ? 13 : 11,
        fontWeight: 800,
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {children ?? (kind ? KIND_BADGE[kind] : "")}
    </span>
  );
}

interface Option {
  id: string;
  kind?: DocKind;
  badge?: ReactNode;
  title: string;
  hint: string;
  disabled?: boolean;
  onPick: () => void;
}

function OptionRow({ o, close }: { o: Option; close: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={o.id}
      disabled={o.disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => {
        close();
        o.onPick();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        textAlign: "left",
        border: "none",
        borderRadius: 10,
        padding: "8px 9px",
        background: hover && !o.disabled ? "var(--hover)" : "transparent",
        cursor: o.disabled ? "default" : "pointer",
        opacity: o.disabled ? 0.55 : 1,
        color: "var(--text)",
        font: "inherit",
      }}
    >
      <KindBadge kind={o.kind}>{o.badge}</KindBadge>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 700 }}>{o.title}</span>
        <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)", lineHeight: 1.35 }}>{o.hint}</span>
      </span>
    </button>
  );
}

/** «＋ Новий документ ▾» — the one entry point for creating any document. */
export function NewDocMenu({
  onCreate,
  onFromShipment,
  onAppendix,
}: {
  onCreate: (kind: "contract" | "invoice" | "ua_invoice") => void;
  onFromShipment: () => void;
  /** Set when a contract is open: the annex is created from it. */
  onAppendix: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const ref = useOutside(open, close);
  const options: Option[] = [
    { id: "docb-new-contract", kind: "contract", title: "Контракт", hint: "Двомовний контракт зі специфікацією (Додаток №1)", onPick: () => onCreate("contract") },
    {
      id: "docb-new-appendix",
      kind: "appendix",
      title: "Додаток до контракту",
      hint: onAppendix ? "Наступний додаток до відкритого контракту" : "Відкрийте контракт — і додаток візьме з нього сторони й умови",
      disabled: !onAppendix,
      onPick: () => onAppendix?.(),
    },
    { id: "docb-new-invoice", kind: "invoice", title: "Інвойс", hint: "Інвойс + пакувальний лист на бланку продавця", onPick: () => onCreate("invoice") },
    { id: "docb-new-ua", kind: "ua_invoice", title: "Видаткова накладна / рахунок", hint: "Продаж в Україні: гривні, ПДВ, сума прописом", onPick: () => onCreate("ua_invoice") },
  ];
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="btn btn-primary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="docb-new-menu"
        style={{ width: "100%", height: 38, fontSize: 13.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
      >
        ＋ Новий документ
        <span style={{ fontSize: 10, transition: "transform .15s", transform: open ? "rotate(180deg)" : "none" }}>▼</span>
      </button>
      {open ? (
        <div role="menu" style={panel}>
          {options.map((o) => (
            <OptionRow key={o.id} o={o} close={close} />
          ))}
          <div style={{ height: 1, background: "var(--border)", margin: "4px 6px" }} />
          <OptionRow
            o={{ id: "docb-from-shipment", badge: "⇩", title: "З постачання…", hint: "Контракт чи інвойс із документів постачання Штурмана", onPick: onFromShipment }}
            close={close}
          />
        </div>
      ) : null}
    </div>
  );
}

export type KindFilter = "all" | DocKind;

/** The list filter: one dropdown with a count per kind. */
export function KindFilterMenu({ value, onChange, counts }: { value: KindFilter; onChange: (v: KindFilter) => void; counts: Record<KindFilter, number> }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const ref = useOutside(open, close);
  const items: { value: KindFilter; label: string; kind?: DocKind }[] = [
    { value: "all", label: "Усі документи" },
    { value: "contract", label: "Контракти", kind: "contract" },
    { value: "appendix", label: "Додатки", kind: "appendix" },
    { value: "invoice", label: "Інвойси", kind: "invoice" },
    { value: "ua_invoice", label: "Накладні / рахунки", kind: "ua_invoice" },
  ];
  const current = items.find((i) => i.value === value) ?? items[0]!;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="docb-filter"
        style={{
          width: "100%",
          height: 32,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px",
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          font: "inherit",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        {current.kind ? <KindBadge kind={current.kind} size={18} /> : null}
        <span style={{ fontWeight: 600 }}>{current.label}</span>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{counts[current.value]}</span>
        <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--muted)", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▼</span>
      </button>
      {open ? (
        <div role="listbox" style={panel}>
          {items.map((i) => (
            <button
              key={i.value}
              type="button"
              role="option"
              aria-selected={i.value === value}
              data-testid={`docb-filter-${i.value}`}
              className="nav-row"
              onClick={() => {
                onChange(i.value);
                close();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                border: "none",
                borderRadius: 8,
                padding: "7px 8px",
                background: i.value === value ? "var(--active)" : "transparent",
                color: "var(--text)",
                font: "inherit",
                fontSize: 13,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              {i.kind ? <KindBadge kind={i.kind} size={18} /> : <span style={{ width: 18 }} />}
              <span style={{ flex: 1, fontWeight: i.value === value ? 700 : 500 }}>{i.label}</span>
              <span style={{ color: "var(--muted)", fontSize: 12 }}>{counts[i.value]}</span>
              {i.value === value ? <span style={{ color: "var(--accent)", fontSize: 12 }}>✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
