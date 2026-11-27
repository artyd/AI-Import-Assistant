"use client";

// A styled drop-in for <input type="date"> / <input type="datetime-local">:
// a button with the date as people write it (26.11.2026) and a month calendar
// in a popover (Monday first, Ukrainian names, «Сьогодні», «Очистити», arrow
// keys). The real native input stays the control — focusable, labelled, typed
// into from the keyboard, found by tests — only visually hidden; the trigger and
// the calendar are a visual layer that writes back through it. Touch / narrow
// screens keep the OS picker.
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { useNativeControls } from "./useNativeControls";

const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { type?: "date" | "datetime-local"; "data-testid"?: string };

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

function parse(v: string): { y: number; m: number; d: number; time: string } | null {
  const mm = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(v || "");
  if (!mm) return null;
  return { y: Number(mm[1]), m: Number(mm[2]) - 1, d: Number(mm[3]), time: mm[4] ?? "" };
}

function todayParts() {
  const t = new Date();
  return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() };
}

const hiddenNative: CSSProperties = { position: "absolute", left: 0, bottom: 0, width: 1, height: 1, opacity: 0, pointerEvents: "none", border: 0, padding: 0, margin: 0 };

const TRIGGER_KEYS = ["width", "minWidth", "maxWidth", "height", "fontSize", "padding", "paddingLeft", "paddingRight", "borderRadius", "background", "color", "border", "borderColor"] as const;
const WRAP_KEYS = ["width", "minWidth", "maxWidth", "flex", "flexBasis", "flexGrow", "flexShrink", "alignSelf", "gridColumn", "margin", "marginLeft", "marginRight", "marginTop", "marginBottom"] as const;

export function DateInput(props: Props) {
  const native = useNativeControls();
  const { type = "date", ...rest } = props;
  if (native) return <input type={type} {...rest} />;
  return <FancyDate {...props} type={type} />;
}

function FancyDate(props: Props) {
  const { type = "date", value, defaultValue, onChange, style = {}, className, disabled, min, max, placeholder, "aria-label": ariaLabel, title, id, ...rest } = props;
  const withTime = type === "datetime-local";
  const nativeRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [own, setOwn] = useState(String(defaultValue ?? ""));
  const current = value === undefined ? own : String(value ?? "");
  const sel = parse(current);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [view, setView] = useState(() => (sel ? { y: sel.y, m: sel.m } : { y: todayParts().y, m: todayParts().m }));
  const [focusDay, setFocusDay] = useState<number>(sel?.d ?? todayParts().d);
  const [time, setTime] = useState(sel?.time || "09:00");
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const h = withTime ? 380 : 340;
    const up = window.innerHeight - r.bottom < h + 12 && r.top > window.innerHeight - r.bottom;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - 300);
    setPos({ left, top: up ? r.top - 6 : r.bottom + 6, up });
  }, [withTime]);

  const emit = useCallback(
    (next: string) => {
      const el = nativeRef.current;
      if (el) {
        // Through the real input: React's onChange gets a genuine event.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, next);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (value === undefined) setOwn(next);
    },
    [value],
  );

  const openPop = () => {
    if (disabled) return;
    const p = parse(current);
    const t = todayParts();
    setView(p ? { y: p.y, m: p.m } : { y: t.y, m: t.m });
    setFocusDay(p?.d ?? t.d);
    setTime(p?.time || "09:00");
    place();
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) nativeRef.current?.focus({ preventScroll: true });
  };

  const allowed = (d: string) => (!min || d >= String(min).slice(0, 10)) && (!max || d <= String(max).slice(0, 10));
  const pick = (y: number, m: number, d: number) => {
    const day = iso(y, m, d);
    if (!allowed(day)) return;
    emit(withTime ? `${day}T${time}` : day);
    close();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      place();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    popRef.current?.querySelector<HTMLElement>("[data-focus='1']")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
  const shift = (months: number) =>
    setView((v) => {
      const d = new Date(v.y, v.m + months, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  const onGridKey = (e: React.KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step) {
      e.preventDefault();
      const d = new Date(view.y, view.m, focusDay + step);
      setView({ y: d.getFullYear(), m: d.getMonth() });
      setFocusDay(d.getDate());
      requestAnimationFrame(() => popRef.current?.querySelector<HTMLElement>("[data-focus='1']")?.focus({ preventScroll: true }));
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      shift(e.key === "PageUp" ? -1 : 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(view.y, view.m, Math.min(focusDay, daysIn(view.y, view.m)));
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const shown = sel ? `${pad(sel.d)}.${pad(sel.m + 1)}.${sel.y}${withTime && sel.time ? `, ${sel.time}` : ""}` : "";

  const triggerStyle: CSSProperties = {};
  for (const k of TRIGGER_KEYS) if (style[k] !== undefined) (triggerStyle as Record<string, unknown>)[k] = style[k];
  const wrapStyle: CSSProperties = { position: "relative", display: "inline-flex", minWidth: 0, verticalAlign: "middle" };
  for (const k of WRAP_KEYS) if (style[k] !== undefined) (wrapStyle as Record<string, unknown>)[k] = style[k];
  const fullWidth = style.width !== undefined || style.flex !== undefined || (className ?? "input").split(/\s+/).includes("input");
  if (style.width === undefined && style.flex === undefined && fullWidth) wrapStyle.width = "100%";
  triggerStyle.width = fullWidth ? "100%" : "auto";

  // Month grid, Monday first.
  const first = (new Date(view.y, view.m, 1).getDay() + 6) % 7;
  const n = daysIn(view.y, view.m);
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: n }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const t = todayParts();
  const fd = Math.min(focusDay, n);

  const navBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: "none", background: "transparent", color: "var(--text)", cursor: "pointer", display: "grid", placeItems: "center", fontSize: 15 };

  return (
    <span style={wrapStyle} className="ui-date">
      <div
        ref={triggerRef}
        aria-hidden
        title={title}
        className={className ?? "input"}
        // A click inside a <label> is forwarded to the hidden native control, which then
        // opens the OS list / date picker over ours — cancel that activation.
        onClick={(e) => e.preventDefault()}
        onMouseDown={(e) => {
          e.preventDefault();
          if (disabled) return;
          nativeRef.current?.focus({ preventScroll: true });
          if (open) close();
          else openPop();
        }}
        data-open={open || undefined}
        data-focused={focused || undefined}
        style={{ display: "flex", alignItems: "center", gap: 8, textAlign: "left", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1, height: 34, padding: "0 10px", fontSize: 13.5, color: "var(--text)", userSelect: "none", boxSizing: "border-box", ...triggerStyle }}
      >
        {/* Text via CSS, not DOM text: it must not join the wrapping <label>'s text. */}
        <span className="ui-val" data-text={shown || placeholder || (withTime ? "дд.мм.рррр, гг:хх" : "дд.мм.рррр")} data-testid="date-shown" style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: shown ? undefined : "var(--muted)" }} />
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden style={{ flex: "none", color: "var(--muted)" }}>
          <rect x="3.5" y="5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.9" />
          <path d="M3.5 9.5h17M8 3v4M16 3v4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      </div>
      <input
        {...rest}
        ref={nativeRef}
        id={id}
        type={type}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        value={value}
        defaultValue={defaultValue}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          if (value === undefined) setOwn(e.target.value);
          onChange?.(e);
        }}
        onKeyDown={(e) => {
          // Digits edit the date as usual; Enter / Space / Alt+↓ open the calendar.
          if (e.key === "Enter" || e.key === " " || (e.altKey && e.key === "ArrowDown")) {
            e.preventDefault();
            if (open) close();
            else openPop();
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            close();
          }
        }}
        // A click inside a <label> is forwarded to the hidden native control, which then
        // opens the OS list / date picker over ours — cancel that activation.
        onClick={(e) => {
          // Reached through its <label> (a click on the field name): open ours, never the OS one.
          e.preventDefault();
          if (!disabled) (open ? close() : openPop());
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          if (!disabled) open ? close() : openPop();
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={hiddenNative}
      />
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popRef}
              role="dialog"
              aria-label="Вибір дати"
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.up ? undefined : pos.top,
                bottom: pos.up ? window.innerHeight - pos.top : undefined,
                width: 288,
                zIndex: 4000,
                background: "var(--menu)",
                border: "1px solid var(--border)",
                borderRadius: 14,
                boxShadow: "var(--shadow)",
                padding: 10,
                animation: "ui-pop .12s ease-out",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
                <button type="button" style={navBtn} onClick={() => shift(-12)} aria-label="Попередній рік" className="nav-row">
                  «
                </button>
                <button type="button" style={navBtn} onClick={() => shift(-1)} aria-label="Попередній місяць" className="nav-row">
                  ‹
                </button>
                <div style={{ flex: 1, textAlign: "center", fontSize: 13.5, fontWeight: 750, textTransform: "capitalize" }} data-testid="date-title">
                  {MONTHS[view.m]} {view.y}
                </div>
                <button type="button" style={navBtn} onClick={() => shift(1)} aria-label="Наступний місяць" className="nav-row">
                  ›
                </button>
                <button type="button" style={navBtn} onClick={() => shift(12)} aria-label="Наступний рік" className="nav-row">
                  »
                </button>
              </div>
              <div role="grid" onKeyDown={onGridKey} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
                {WEEKDAYS.map((w, i) => (
                  <div key={w} style={{ textAlign: "center", fontSize: 10.5, fontWeight: 750, color: i > 4 ? "var(--err)" : "var(--muted)", padding: "4px 0" }}>
                    {w}
                  </div>
                ))}
                {cells.map((d, i) => {
                  if (d === null) return <div key={`e${i}`} />;
                  const day = iso(view.y, view.m, d);
                  const isSel = !!sel && sel.y === view.y && sel.m === view.m && sel.d === d;
                  const isToday = t.y === view.y && t.m === view.m && t.d === d;
                  const ok = allowed(day);
                  const weekend = i % 7 > 4;
                  return (
                    <button
                      key={day}
                      type="button"
                      role="gridcell"
                      aria-selected={isSel}
                      aria-label={`${d} ${MONTHS[view.m]} ${view.y}`}
                      data-focus={d === fd ? "1" : undefined}
                      tabIndex={d === fd ? 0 : -1}
                      disabled={!ok}
                      onClick={() => pick(view.y, view.m, d)}
                      className={isSel ? undefined : "nav-row"}
                      style={{
                        height: 34,
                        borderRadius: 9,
                        border: isToday && !isSel ? "1px solid var(--accent)" : "1px solid transparent",
                        background: isSel ? "var(--accent)" : "transparent",
                        color: isSel ? "#fff" : !ok ? "var(--faint)" : weekend ? "var(--err)" : "var(--text)",
                        fontWeight: isSel || isToday ? 750 : 500,
                        fontSize: 13,
                        cursor: ok ? "pointer" : "default",
                        font: "inherit",
                      }}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
              {withTime ? (
                <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12.5, color: "var(--muted)" }}>
                  Час
                  <input
                    type="time"
                    className="input"
                    value={time}
                    onChange={(e) => {
                      setTime(e.target.value);
                      if (sel) emit(`${iso(sel.y, sel.m, sel.d)}T${e.target.value}`);
                    }}
                    style={{ height: 30, fontSize: 13, padding: "0 8px", flex: 1 }}
                  />
                </label>
              ) : null}
              <div style={{ display: "flex", gap: 6, marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                <button
                  type="button"
                  className="nav-row"
                  onClick={() => pick(t.y, t.m, t.d)}
                  style={{ border: "none", background: "transparent", color: "var(--accent)", fontWeight: 700, fontSize: 12.5, padding: "5px 8px", borderRadius: 8, cursor: "pointer", font: "inherit" }}
                >
                  Сьогодні
                </button>
                {current ? (
                  <button
                    type="button"
                    className="nav-row"
                    onClick={() => {
                      emit("");
                      close();
                    }}
                    style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--muted)", fontSize: 12.5, padding: "5px 8px", borderRadius: 8, cursor: "pointer", font: "inherit" }}
                  >
                    Очистити
                  </button>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
