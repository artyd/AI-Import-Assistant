"use client";

import { useEffect } from "react";

export type NoticeTone = "error" | "info";

/** Inline, click-to-dismiss notice (the chat composer's error strip). */
export function Notice({
  text,
  onClear,
  tone = "error",
}: {
  text: string;
  onClear: () => void;
  tone?: NoticeTone;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      onClick={onClear}
      style={{
        marginBottom: 8,
        padding: "8px 12px",
        borderRadius: 10,
        background: tone === "error" ? "var(--errBg)" : "var(--okBg)",
        color: tone === "error" ? "var(--err)" : "var(--ok)",
        fontSize: 13,
        cursor: "pointer",
        whiteSpace: "pre-line",
      }}
    >
      {text}
    </div>
  );
}

/**
 * Page-level dismissible banner (replaces blocking `alert()`): floats at the
 * top centre, closes on click / ×, and auto-hides after `autoHideMs`.
 */
export function NoticeBanner({
  text,
  tone = "error",
  onClose,
  autoHideMs = 10_000,
}: {
  text: string;
  tone?: NoticeTone;
  onClose: () => void;
  autoHideMs?: number;
}) {
  useEffect(() => {
    if (!autoHideMs) return;
    const t = setTimeout(onClose, autoHideMs);
    return () => clearTimeout(t);
  }, [text, autoHideMs, onClose]);

  return (
    <div
      data-testid="notice-banner"
      style={{
        position: "fixed",
        top: 14,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 80,
        width: "min(560px, calc(100vw - 32px))",
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "10px 10px 10px 14px",
        borderRadius: 12,
        background: "var(--surface)",
        border: `1px solid ${tone === "error" ? "var(--err)" : "var(--ok)"}`,
        boxShadow: "var(--shadow)",
      }}
    >
      <div
        role={tone === "error" ? "alert" : "status"}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          lineHeight: 1.45,
          color: tone === "error" ? "var(--err)" : "var(--text)",
          whiteSpace: "pre-line",
          maxHeight: 220,
          overflowY: "auto",
        }}
      >
        {text}
      </div>
      <button
        onClick={onClose}
        aria-label="Закрити повідомлення"
        title="Закрити"
        style={{
          flex: "none",
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          borderRadius: 6,
          background: "transparent",
          color: "var(--muted)",
          cursor: "pointer",
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}
