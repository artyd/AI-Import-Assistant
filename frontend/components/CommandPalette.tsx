"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LnSearch } from "./LineIcons";

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  keywords?: string;
  run: () => void;
}

interface Props {
  actions: PaletteAction[];
  onClose: () => void;
}

export function CommandPalette({ actions, onClose }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.keywords ?? "").toLowerCase().includes(q)
    );
  }, [actions, query]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 150,
        background: "rgba(10,10,14,.42)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "11vh 24px 24px",
        animation: "overlayIn .12s ease both",
      }}
      data-anim
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: "100%",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          boxShadow: "var(--shadow)",
          overflow: "hidden",
          animation: "popIn .16s ease both",
        }}
        data-anim
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "15px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ color: "var(--muted)", display: "flex" }}>
            <LnSearch size={18} />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered[0]) {
                onClose();
                filtered[0].run();
              }
            }}
            placeholder="Команда або дія…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 15,
              color: "var(--text)",
            }}
          />
          <span
            style={{
              flex: "none",
              fontSize: 10.5,
              fontWeight: 600,
              color: "var(--muted)",
              padding: "3px 7px",
              borderRadius: 6,
              background: "var(--hover)",
            }}
          >
            ESC
          </span>
        </div>
        <div style={{ maxHeight: 344, overflowY: "auto", padding: 6 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "16px 12px", fontSize: 13, color: "var(--muted)" }}>
              Нічого не знайдено.
            </div>
          ) : (
            filtered.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  onClose();
                  a.run();
                }}
                className="nav-row"
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "11px 12px",
                  background: "transparent",
                  border: "none",
                  borderRadius: 10,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    flex: "none",
                    width: 34,
                    height: 34,
                    borderRadius: 9,
                    background: "var(--hover)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--accent)",
                  }}
                >
                  {a.icon}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, color: "var(--text)" }}>
                  {a.label}
                </span>
                {a.hint && (
                  <span style={{ flex: "none", fontSize: 11.5, color: "var(--faint)" }}>{a.hint}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
