"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LnLock, LnMoon, LnSettings, LnSoundOff, LnSoundOn, LnSun } from "../ui/LineIcons";
import "../legal/legal.css";

interface Props {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  sound: boolean;
  onToggleSound: () => void;
  onLock: () => void;
}

/** Gear in the top-right corner: theme, sound, lock and the legal links in one menu. */
export function SettingsMenu({ theme, onToggleTheme, sound, onToggleSound, onLock }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const row: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 11,
    width: "100%",
    height: 38,
    padding: "0 10px",
    background: "transparent",
    border: "none",
    borderRadius: 9,
    cursor: "pointer",
    color: "var(--text)",
    fontSize: 13.5,
    fontWeight: 500,
    textAlign: "left",
  };
  const icon: React.CSSProperties = { flex: "none", color: "var(--muted)", display: "flex", width: 18, justifyContent: "center" };

  return (
    <div ref={ref} style={{ position: "relative", flex: "none" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Налаштування"
        aria-label="Налаштування"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="settings-button"
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: open ? "var(--accentSoft)" : "transparent",
          border: `1px solid ${open ? "transparent" : "var(--border)"}`,
          color: open ? "var(--accent)" : "var(--muted)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <LnSettings size={17} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Налаштування"
          data-testid="settings-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 248,
            padding: 6,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "var(--shadow)",
            zIndex: 50,
          }}
        >
          <div style={{ padding: "6px 10px 6px", fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: "var(--faint)", textTransform: "uppercase" }}>
            Налаштування
          </div>

          <button role="menuitem" className="nav-row" style={row} onClick={onToggleTheme} aria-label="Тема оформлення">
            <span style={icon}>{theme === "dark" ? <LnSun size={17} /> : <LnMoon size={16} />}</span>
            <span style={{ flex: 1 }}>Тема</span>
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{theme === "dark" ? "Темна" : "Світла"}</span>
          </button>

          <button role="menuitemcheckbox" aria-checked={sound} className="nav-row" style={row} onClick={onToggleSound} aria-label="Звук">
            <span style={icon}>{sound ? <LnSoundOn size={17} /> : <LnSoundOff size={17} />}</span>
            <span style={{ flex: 1 }}>Звук</span>
            <Switch on={sound} />
          </button>

          <div style={{ height: 1, background: "var(--border)", margin: "6px 4px" }} />

          <button
            role="menuitem"
            className="nav-row"
            style={row}
            onClick={() => {
              setOpen(false);
              onLock();
            }}
            aria-label="Заблокувати"
          >
            <span style={icon}>
              <LnLock size={16} />
            </span>
            Заблокувати (вийти)
          </button>

          <div style={{ height: 1, background: "var(--border)", margin: "6px 4px" }} />

          <div className="legal-foot" style={{ justifyContent: "flex-start", padding: "4px 10px 6px" }}>
            <Link href="/privacy" role="menuitem">
              Конфіденційність
            </Link>
            <span aria-hidden="true">·</span>
            <Link href="/terms" role="menuitem">
              Умови
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        flex: "none",
        position: "relative",
        width: 30,
        height: 18,
        borderRadius: 9,
        background: on ? "var(--accent)" : "var(--border2)",
        transition: "background 150ms",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 14 : 2,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 150ms",
        }}
      />
    </span>
  );
}
