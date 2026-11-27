"use client";

// A styled drop-in for <select>. Same props and children (<option>, <optgroup>),
// same onChange(event). The real native <select> stays the control — focusable,
// labelled, announced by screen readers, found by tests — only visually hidden;
// the styled trigger and list are a visual layer over it that writes the value
// back through the native element.
// On touch / narrow screens the native select is shown as is (the mobile layout
// is frozen and OS pickers are better there).
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { useNativeControls } from "./useNativeControls";

export interface SelectOption {
  value: string;
  label: string;
  disabled: boolean;
  group: string | null;
}

/** Text of an <option>'s children. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** Flattens <option>/<optgroup> children (through fragments and arrays). */
export function optionsOf(children: ReactNode, group: string | null = null): SelectOption[] {
  const out: SelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ value?: unknown; children?: ReactNode; disabled?: boolean; label?: string }>;
    if (el.type === "option") {
      const label = textOf(el.props.children);
      out.push({ value: el.props.value === undefined ? label : String(el.props.value), label, disabled: !!el.props.disabled, group });
    } else if (el.type === "optgroup") {
      out.push(...optionsOf(el.props.children, el.props.label ?? null));
    } else if (el.props.children !== undefined) {
      out.push(...optionsOf(el.props.children, group));
    }
  });
  return out;
}

type Props = SelectHTMLAttributes<HTMLSelectElement> & { "data-testid"?: string };

const hiddenNative: CSSProperties = {
  position: "absolute",
  left: 0,
  bottom: 0,
  width: 1,
  height: 1,
  opacity: 0,
  pointerEvents: "none",
  border: 0,
  padding: 0,
  margin: 0,
};

/** Style keys that size / place the control — they go to the visible trigger. */
const TRIGGER_KEYS = ["width", "minWidth", "maxWidth", "height", "minHeight", "flex", "flexBasis", "flexGrow", "flexShrink", "margin", "marginLeft", "marginRight", "marginTop", "marginBottom", "fontSize", "fontWeight", "alignSelf", "gridColumn", "padding", "paddingLeft", "paddingRight", "borderRadius", "background", "color", "border", "borderColor"] as const;

export function Select(props: Props) {
  const native = useNativeControls();
  const { children, style, className, disabled, value, defaultValue, ...rest } = props;
  if (native) {
    return (
      <select {...rest} value={value} defaultValue={defaultValue} disabled={disabled} className={className} style={style}>
        {children}
      </select>
    );
  }
  return (
    <FancySelect {...props} />
  );
}

function FancySelect(props: Props) {
  const { children, style = {}, className, disabled, value, defaultValue, onChange, "aria-label": ariaLabel, title, id, ...rest } = props;
  const options = useMemo(() => optionsOf(children), [children]);
  const nativeRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number; up: boolean } | null>(null);
  const [uncontrolled, setUncontrolled] = useState<string>(defaultValue === undefined ? options[0]?.value ?? "" : String(defaultValue));
  const listId = useId();

  const current = value === undefined ? uncontrolled : String(value ?? "");
  const selected = options.find((o) => o.value === current) ?? null;
  const searchable = options.length > 9;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const want = Math.min(340, options.length * 34 + (searchable ? 50 : 12));
    const up = below < Math.min(want, 220) && above > below;
    const width = Math.max(r.width, 200);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    setPos({ left, top: up ? r.top - 6 : r.bottom + 6, width, maxH: Math.max(140, Math.min(340, up ? above : below)), up });
  }, [options.length, searchable]);

  const openList = useCallback(() => {
    if (disabled) return;
    place();
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
    setOpen(true);
  }, [disabled, place, options, current]);

  const close = useCallback((focusBack = true) => {
    setOpen(false);
    if (focusBack) nativeRef.current?.focus({ preventScroll: true });
  }, []);

  const choose = useCallback(
    (o: SelectOption) => {
      if (o.disabled) return;
      const el = nativeRef.current;
      if (el) {
        // Through the real <select>: React's onChange gets a genuine change event.
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        setter?.call(el, o.value);
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (value === undefined) setUncontrolled(o.value);
      close();
    },
    [close, value],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      place();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (listRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, place, close]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const typeahead = useRef({ text: "", at: 0 });
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    const move = (d: number) => {
      e.preventDefault();
      if (!visible.length) return;
      let i = active;
      for (let k = 0; k < visible.length; k++) {
        i = (i + d + visible.length) % visible.length;
        if (!visible[i]!.disabled) break;
      }
      setActive(i);
    };
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(visible.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = visible[active];
      if (o) choose(o);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") close(false);
    else if (!searchable && e.key.length === 1) {
      const now = Date.now();
      typeahead.current = { text: (now - typeahead.current.at < 700 ? typeahead.current.text : "") + e.key.toLowerCase(), at: now };
      const i = visible.findIndex((o) => o.label.toLowerCase().startsWith(typeahead.current.text));
      if (i >= 0) setActive(i);
    }
  };

  const triggerStyle: CSSProperties = {};
  for (const k of TRIGGER_KEYS) if (style[k] !== undefined) (triggerStyle as Record<string, unknown>)[k] = style[k];
  const wrapStyle: CSSProperties = { position: "relative", display: style.display === "none" ? "none" : "inline-flex", minWidth: 0, verticalAlign: "middle" };
  for (const k of ["width", "minWidth", "maxWidth", "flex", "flexBasis", "flexGrow", "flexShrink", "alignSelf", "gridColumn", "margin", "marginLeft", "marginRight", "marginTop", "marginBottom"] as const) {
    if (style[k] !== undefined) {
      (wrapStyle as Record<string, unknown>)[k] = style[k];
      if (k.startsWith("margin")) delete (triggerStyle as Record<string, unknown>)[k];
    }
  }
  // Like the native control: full width when sized explicitly or styled as .input
  // (which is width:100%); otherwise as wide as its content.
  const fullWidth = style.width !== undefined || style.flex !== undefined || (className ?? "input").split(/\s+/).includes("input");
  if (style.width === undefined && style.flex === undefined && fullWidth) wrapStyle.width = "100%";
  triggerStyle.width = fullWidth ? "100%" : "auto";

  const groups: { group: string | null; items: { o: SelectOption; i: number }[] }[] = [];
  visible.forEach((o, i) => {
    const last = groups[groups.length - 1];
    if (last && last.group === o.group) last.items.push({ o, i });
    else groups.push({ group: o.group, items: [{ o, i }] });
  });

  return (
    <span style={wrapStyle} className="ui-select">
      <div
        ref={triggerRef}
        aria-hidden
        title={title}
        className={className ?? "input"}
        onMouseDown={(e) => {
          e.preventDefault();
          if (disabled) return;
          nativeRef.current?.focus({ preventScroll: true });
          if (open) close();
          else openList();
        }}
        data-open={open || undefined}
        data-focused={focused || undefined}
        data-disabled={disabled || undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          textAlign: "left",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.6 : 1,
          height: 34,
          padding: "0 10px",
          fontSize: 13.5,
          color: "var(--text)",
          userSelect: "none",
          boxSizing: "border-box",
          ...triggerStyle,
        }}
      >
        {/* Text via CSS, not DOM text: it must not join the wrapping <label>'s text. */}
        <span className="ui-val" data-text={selected?.label ?? options[0]?.label ?? ""} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: selected ? undefined : "var(--muted)" }} />
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden style={{ flex: "none", color: "var(--muted)", transition: "transform .15s", transform: open ? "rotate(180deg)" : "none" }}>
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <select
        {...rest}
        ref={nativeRef}
        id={id}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        value={value}
        defaultValue={defaultValue}
        onChange={(e) => {
          if (value === undefined) setUncontrolled(e.target.value);
          onChange?.(e);
        }}
        onKeyDown={(e) => {
          // Open / drive the styled list; letters keep the native type-to-select.
          if (open || ["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) onKey(e);
        }}
        onMouseDown={(e) => {
          // A click that reaches the native control (e.g. via its <label>) opens the styled list instead.
          e.preventDefault();
          if (!disabled) open ? close() : openList();
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        style={hiddenNative}
      >
        {children}
      </select>
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              onKeyDown={onKey}
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.up ? undefined : pos.top,
                bottom: pos.up ? window.innerHeight - pos.top : undefined,
                width: pos.width,
                maxHeight: pos.maxH,
                zIndex: 4000,
                display: "flex",
                flexDirection: "column",
                background: "var(--menu)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                boxShadow: "var(--shadow)",
                overflow: "hidden",
                animation: "ui-pop .12s ease-out",
              }}
            >
              {searchable ? (
                <div style={{ padding: 6, borderBottom: "1px solid var(--border)" }}>
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onKey}
                    placeholder="Пошук…"
                    className="input"
                    style={{ width: "100%", height: 30, fontSize: 13, padding: "0 9px" }}
                  />
                </div>
              ) : null}
              <div style={{ overflowY: "auto", padding: 4 }} tabIndex={-1} ref={(el) => { if (el && !searchable && !el.contains(document.activeElement)) el.focus({ preventScroll: true }); }} onKeyDown={searchable ? undefined : onKey}>
                {visible.length === 0 ? <div style={{ padding: "8px 10px", fontSize: 12.5, color: "var(--muted)" }}>Нічого не знайдено</div> : null}
                {groups.map((g, gi) => (
                  <div key={gi} role="group" aria-label={g.group ?? undefined}>
                    {g.group ? (
                      <div style={{ padding: "6px 10px 3px", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--muted)" }}>{g.group}</div>
                    ) : null}
                    {g.items.map(({ o, i }) => {
                      const isSel = o.value === current;
                      return (
                        <div
                          key={`${o.value}-${i}`}
                          role="option"
                          aria-selected={isSel}
                          aria-disabled={o.disabled || undefined}
                          data-index={i}
                          onMouseEnter={() => setActive(i)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => choose(o)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "7px 10px",
                            borderRadius: 8,
                            fontSize: 13,
                            cursor: o.disabled ? "default" : "pointer",
                            opacity: o.disabled ? 0.45 : 1,
                            color: "var(--text)",
                            background: i === active ? "var(--hover)" : isSel ? "var(--active)" : "transparent",
                            fontWeight: isSel ? 650 : 450,
                          }}
                        >
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.label}>
                            {o.label || " "}
                          </span>
                          {isSel ? (
                            <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden style={{ flex: "none", color: "var(--accent)" }}>
                              <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
