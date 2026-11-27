"use client";

// The app's picker / filter dropdown, in the look of the document builder's
// menus: a pill trigger («Тип: Море · 12 ▾») and a card list where every option
// can carry a colour dot, an icon, a hint line and a count. Single choice
// (`value`) or several at once (`values`, with «Усі» to reset). Replaces rows of
// filter chips and plain selects, so a filter bar stays one line however many
// options it has.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface DropdownOption<V extends string = string> {
  value: V;
  label: string;
  /** Second line under the label. */
  hint?: string;
  /** A colour dot / swatch before the label. */
  color?: string;
  /** An icon (emoji or element) before the label; wins over `color`. */
  icon?: ReactNode;
  count?: number;
  group?: string;
  disabled?: boolean;
}

interface Common<V extends string> {
  options: DropdownOption<V>[];
  /** Prefix inside the trigger: «Тип», «Хто везе». */
  label?: string;
  /** Text when nothing is chosen (single) / all are chosen (multi). */
  placeholder?: string;
  testId?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** The trigger stretches to its container. */
  block?: boolean;
  size?: "sm" | "md";
  /** Highlights the trigger when a filter is applied. */
  activeTint?: boolean;
  /** List width; by default at least the trigger's. */
  menuWidth?: number;
  style?: CSSProperties;
  title?: string;
  /** Extra row(s) at the end of the list (e.g. «＋ Додати»). */
  footer?: (close: () => void) => ReactNode;
}

interface Single<V extends string> extends Common<V> {
  multiple?: false;
  value: V;
  onChange: (v: V) => void;
}

interface Multi<V extends string> extends Common<V> {
  multiple: true;
  values: V[];
  onChange: (v: V[]) => void;
  /** «Усі» chip text in the list; empty selection means «all». */
  allLabel?: string;
}

export type DropdownProps<V extends string> = Single<V> | Multi<V>;

const SEARCH_FROM = 9;

function Swatch({ o, size = 10 }: { o: Pick<DropdownOption, "color" | "icon">; size?: number }) {
  if (o.icon !== undefined && o.icon !== null) return <span aria-hidden style={{ width: 18, flex: "none", display: "grid", placeItems: "center", fontSize: 14, lineHeight: 1 }}>{o.icon}</span>;
  if (o.color) return <span aria-hidden style={{ width: size, height: size, flex: "none", borderRadius: 99, background: o.color, boxShadow: `0 0 0 3px color-mix(in srgb, ${o.color} 18%, transparent)` }} />;
  return null;
}

export function Dropdown<V extends string>(props: DropdownProps<V>) {
  const { options, label, placeholder, testId, ariaLabel, disabled, block, size = "md", activeTint = true, menuWidth, style, title, footer } = props;
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const typed = useRef({ s: "", t: 0 });

  const multiple = props.multiple === true;
  const chosen = useMemo(() => new Set<string>(multiple ? (props as Multi<V>).values : [(props as Single<V>).value]), [multiple, props]);
  const searchable = options.length >= SEARCH_FROM;
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => `${o.label} ${o.hint ?? ""} ${o.group ?? ""}`.toLowerCase().includes(s)) : options;
  }, [options, q]);

  const close = useCallback((focus = true) => {
    setOpen(false);
    setQ("");
    if (focus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 240 && above > below;
    const width = Math.max(menuWidth ?? 0, r.width, 220);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos({ left, top: up ? r.top - 6 : r.bottom + 6, width, maxHeight: Math.min(420, up ? above : below), up });
  }, [menuWidth]);

  const openList = () => {
    if (disabled) return;
    place();
    const i = options.findIndex((o) => chosen.has(o.value));
    setActive(Math.max(0, i));
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScroll = (e: Event) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      place();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("mousedown", down);
    if (searchable) setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 0);
    return () => document.removeEventListener("mousedown", down);
  }, [open, close, searchable]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (o: DropdownOption<V>) => {
    if (o.disabled) return;
    if (multiple) {
      const p = props as Multi<V>;
      const set = new Set(p.values);
      if (set.has(o.value)) set.delete(o.value);
      else set.add(o.value);
      p.onChange(options.filter((x) => set.has(x.value)).map((x) => x.value));
    } else {
      (props as Single<V>).onChange(o.value);
      close();
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    const step = (d: number) => {
      e.preventDefault();
      let i = active;
      for (let k = 0; k < shown.length; k++) {
        i = (i + d + shown.length) % shown.length;
        if (!shown[i]?.disabled) break;
      }
      setActive(i);
    };
    if (e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowUp") step(-1);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(shown.length - 1);
    else if (e.key === "Enter" || (e.key === " " && !searchable)) {
      e.preventDefault();
      const o = shown[active];
      if (o) pick(o);
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      close(e.key === "Escape");
    } else if (!searchable && e.key.length === 1) {
      const now = Date.now();
      typed.current = { s: (now - typed.current.t < 700 ? typed.current.s : "") + e.key.toLowerCase(), t: now };
      const i = shown.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.s));
      if (i >= 0) setActive(i);
    }
  };

  // ---- trigger text ----
  let current: DropdownOption<V> | undefined;
  let text: string;
  let count: number | undefined;
  let applied: boolean;
  if (multiple) {
    const vals = (props as Multi<V>).values;
    applied = vals.length > 0 && vals.length < options.length;
    if (!applied) text = placeholder ?? (props as Multi<V>).allLabel ?? "усі";
    else if (vals.length === 1) {
      current = options.find((o) => o.value === vals[0]);
      text = current?.label ?? "";
    } else text = `${vals.length} з ${options.length}`;
  } else {
    current = options.find((o) => o.value === (props as Single<V>).value);
    text = current?.label ?? placeholder ?? "";
    count = current?.count;
    applied = !!current && options[0]?.value !== current.value;
  }
  const h = size === "sm" ? 30 : 34;
  const tint = activeTint && applied;

  const groups: { name: string | null; items: { o: DropdownOption<V>; i: number }[] }[] = [];
  shown.forEach((o, i) => {
    const g = o.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.name === g) last.items.push({ o, i });
    else groups.push({ name: g, items: [{ o, i }] });
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ui-dd"
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel ?? (label ? `${label}: ${text}` : undefined)}
        title={title}
        disabled={disabled}
        data-open={open || undefined}
        data-applied={tint || undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKey}
        style={{
          display: block ? "flex" : "inline-flex",
          width: block ? "100%" : undefined,
          alignItems: "center",
          gap: 7,
          height: h,
          maxWidth: "100%",
          padding: size === "sm" ? "0 9px" : "0 11px",
          borderRadius: 10,
          border: `1px solid ${tint ? "color-mix(in srgb, var(--accent) 55%, var(--border))" : "var(--border)"}`,
          background: tint ? "color-mix(in srgb, var(--accent) 9%, var(--surface))" : "var(--surface)",
          color: "var(--text)",
          font: "inherit",
          fontSize: size === "sm" ? 12.5 : 13,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.55 : 1,
          whiteSpace: "nowrap",
          minWidth: 0,
          boxSizing: "border-box",
          transition: "border-color .12s, background .12s, box-shadow .12s",
          ...style,
        }}
      >
        {label ? <span style={{ color: "var(--muted)", flex: "none" }}>{label}:</span> : null}
        {current ? <Swatch o={current} size={9} /> : null}
        <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: block ? 1 : undefined, textAlign: "left" }}>{text}</span>
        {count !== undefined ? <span style={{ color: "var(--muted)", fontSize: 11.5, flex: "none" }}>{count}</span> : null}
        <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden style={{ flex: "none", marginLeft: block ? 0 : 1, color: "var(--muted)", transition: "transform .15s", transform: open ? "rotate(180deg)" : "none" }}>
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-multiselectable={multiple || undefined}
              data-testid={testId ? `${testId}-list` : undefined}
              onKeyDown={onKey}
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.up ? undefined : pos.top,
                bottom: pos.up ? window.innerHeight - pos.top : undefined,
                width: pos.width,
                maxHeight: pos.maxHeight,
                zIndex: 4000, // above the map panels (≤1300) and modals
                display: "flex",
                flexDirection: "column",
                background: "var(--menu)",
                border: "1px solid var(--border)",
                borderRadius: 14,
                boxShadow: "var(--shadow)",
                padding: 6,
                animation: "ui-pop .12s ease-out",
                transformOrigin: pos.up ? "bottom" : "top",
              }}
            >
              {searchable ? (
                <input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setActive(0);
                  }}
                  placeholder="Пошук…"
                  aria-label="Пошук у списку"
                  className="input"
                  style={{ height: 32, fontSize: 13, padding: "0 10px", margin: "0 0 6px", flex: "none" }}
                />
              ) : null}
              <div style={{ overflowY: "auto", minHeight: 0, display: "grid", gap: 1 }}>
                {multiple ? (
                  <button
                    type="button"
                    className="nav-row"
                    data-testid={testId ? `${testId}-all` : undefined}
                    onClick={() => (props as Multi<V>).onChange([])}
                    style={rowStyle(false, false)}
                  >
                    <span style={{ width: 18, flex: "none", textAlign: "center", color: "var(--accent)" }}>{!applied ? "✓" : ""}</span>
                    <span style={{ flex: 1, fontWeight: !applied ? 700 : 500 }}>{(props as Multi<V>).allLabel ?? "Усі"}</span>
                  </button>
                ) : null}
                {shown.length === 0 ? <div style={{ padding: "8px 10px", fontSize: 12.5, color: "var(--muted)" }}>Нічого не знайдено</div> : null}
                {groups.map((g, gi) => (
                  <div key={gi} style={{ display: "grid", gap: 1 }}>
                    {g.name ? <div style={{ padding: "8px 10px 3px", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--faint)" }}>{g.name}</div> : null}
                    {g.items.map(({ o, i }) => {
                      const sel = chosen.has(o.value);
                      return (
                        <button
                          key={o.value}
                          type="button"
                          role="option"
                          aria-selected={sel}
                          aria-disabled={o.disabled || undefined}
                          data-idx={i}
                          data-testid={testId ? `${testId}-opt-${o.value}` : undefined}
                          onMouseEnter={() => setActive(i)}
                          onClick={() => pick(o)}
                          style={rowStyle(i === active, sel, o.disabled)}
                        >
                          {multiple ? (
                            <span
                              aria-hidden
                              style={{
                                width: 16,
                                height: 16,
                                flex: "none",
                                borderRadius: 5,
                                border: `1.5px solid ${sel ? "var(--accent)" : "var(--border)"}`,
                                background: sel ? "var(--accent)" : "transparent",
                                color: "#fff",
                                fontSize: 11,
                                display: "grid",
                                placeItems: "center",
                              }}
                            >
                              {sel ? "✓" : ""}
                            </span>
                          ) : null}
                          <Swatch o={o} />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: "block", fontWeight: sel && !multiple ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</span>
                            {o.hint ? <span style={{ display: "block", fontSize: 11.5, color: "var(--muted)", lineHeight: 1.35, whiteSpace: "normal" }}>{o.hint}</span> : null}
                          </span>
                          {o.count !== undefined ? <span style={{ color: "var(--muted)", fontSize: 12, flex: "none", fontVariantNumeric: "tabular-nums" }}>{o.count}</span> : null}
                          {!multiple && sel ? <span style={{ color: "var(--accent)", fontSize: 12, flex: "none" }}>✓</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              {footer ? <div style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 4, flex: "none" }}>{footer(() => close())}</div> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function rowStyle(active: boolean, selected: boolean, disabled?: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 9,
    width: "100%",
    textAlign: "left",
    border: "none",
    borderRadius: 9,
    padding: "7px 9px",
    background: active && !disabled ? "var(--hover)" : selected ? "var(--active)" : "transparent",
    color: "var(--text)",
    font: "inherit",
    fontSize: 13,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
