"use client";

import { useState } from "react";
import type { ConversationMeta } from "@/lib/types";
import { IconHistory, IconChevronDown, IconPlus } from "./icons";

interface Props {
  conversations: ConversationMeta[];
  currentId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("uk-UA", {
      day: "numeric",
      month: "short",
    });
  } catch {
    return "";
  }
}

export function ConversationsBar({ conversations, currentId, onSelect, onNew }: Props) {
  const [open, setOpen] = useState(false);
  const current = conversations.find((c) => c.id === currentId);
  const label = current?.title?.trim() || (currentId ? "Розмова" : "Нова розмова");

  return (
    <div
      style={{
        flex: "none",
        height: 46,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--chat)",
      }}
    >
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={conversations.length === 0}
          className="ellipsis"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            maxWidth: "100%",
            height: 32,
            padding: "0 10px",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--surface)",
            color: "var(--text)",
            font: "inherit",
            fontWeight: 600,
            cursor: conversations.length ? "pointer" : "default",
          }}
          title="Історія розмов"
        >
          <IconHistory size={15} />
          <span className="ellipsis" style={{ minWidth: 0 }}>{label}</span>
          {conversations.length > 0 && <IconChevronDown size={14} />}
        </button>

        {open && (
          <>
            <div
              onClick={() => setOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: 40 }}
            />
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                zIndex: 41,
                marginTop: 4,
                minWidth: 260,
                maxWidth: 360,
                maxHeight: 320,
                overflowY: "auto",
                background: "var(--menu)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                boxShadow: "var(--shadow)",
                padding: 4,
              }}
            >
              {conversations.map((c) => {
                const active = c.id === currentId;
                return (
                  <button
                    key={c.id}
                    onClick={() => {
                      setOpen(false);
                      onSelect(c.id);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                      width: "100%",
                      textAlign: "left",
                      border: "none",
                      background: active ? "var(--hover)" : "transparent",
                      color: "var(--text)",
                      font: "inherit",
                      fontSize: 13,
                      padding: "8px 8px",
                      borderRadius: 6,
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      if (!active) e.currentTarget.style.background = "var(--hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!active) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span
                      className="ellipsis"
                      style={{ flex: 1, minWidth: 0, fontWeight: active ? 600 : 400 }}
                    >
                      {c.title?.trim() || "Розмова"}
                    </span>
                    <span style={{ color: "var(--muted)", fontSize: 11, flex: "none" }}>
                      {fmt(c.updated_at)}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <button
        className="btn"
        onClick={onNew}
        style={{ height: 32, padding: "0 12px", flex: "none" }}
        title="Почати нову розмову"
      >
        <IconPlus size={15} /> Новий чат
      </button>
    </div>
  );
}
