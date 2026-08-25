"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

export interface ComboOption {
  value: string;
  label: string;
}

/**
 * Lightweight searchable combobox (no UI library). Free text is allowed — the
 * typed value is kept even if it isn't in the option list, so messy import data
 * still saves. Click-outside closes the panel (pattern from WorkspaceSelector).
 */
export function Combobox({
  value,
  onChange,
  options,
  onSearch,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  onSearch?: (q: string) => ComboOption[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const ref = useRef<HTMLDivElement>(null);

  // Keep the visible text in sync when the bound value changes externally.
  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const list = (onSearch ? onSearch(query) : filterByLabel(options, query)).slice(0, 50);

  const panel: CSSProperties = {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    right: 0,
    zIndex: 30,
    background: "var(--menu)",
    boxShadow: "var(--shadow)",
    borderRadius: 8,
    padding: 6,
    maxHeight: 260,
    overflowY: "auto",
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <input
        className="input"
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value); // free text is a valid value
          setOpen(true);
        }}
      />
      {open && list.length > 0 && (
        <div className="panel" style={panel}>
          {list.map((o) => (
            <button
              key={o.value}
              type="button"
              className="tree-row"
              onClick={() => {
                onChange(o.value);
                setQuery(o.value);
                setOpen(false);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "7px 10px",
                border: "none",
                background: o.value === value ? "var(--hover)" : "transparent",
                cursor: "pointer",
                color: "var(--text)",
                font: "inherit",
                borderRadius: 6,
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function filterByLabel(options: ComboOption[], q: string): ComboOption[] {
  const s = q.trim().toLowerCase();
  if (!s) return options;
  return options.filter((o) => o.label.toLowerCase().includes(s));
}
