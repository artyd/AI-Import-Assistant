"use client";

import type { ConversationMeta, Workspace } from "@/lib/types";
import {
  LnChat,
  LnChevronDown,
  LnFolderPlus,
  LnPanelLeft,
  LnPencil,
  LnSearch,
  LnTrash,
} from "./LineIcons";

interface Props {
  workspaces: Workspace[];
  current: Workspace;
  conversations: ConversationMeta[];
  currentConversationId?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNewChat: () => void;
  onNewShipment: () => void;
  onOpenSearch: () => void;
  onSelectShipment: (id: string) => void;
  onDeleteShipment: () => void;
  onSelectConversation: (id: string) => void;
}

function shipmentLabel(w: Workspace): string {
  const base = `№${w.number ?? "—"}`;
  return w.supplier ? `${base} · ${w.supplier}` : base;
}

export function SidebarNav(props: Props) {
  const {
    workspaces,
    current,
    conversations,
    currentConversationId,
    collapsed,
    onToggleCollapsed,
    onNewChat,
    onNewShipment,
    onOpenSearch,
    onSelectShipment,
    onDeleteShipment,
    onSelectConversation,
  } = props;

  if (collapsed) {
    const railBtn: React.CSSProperties = {
      width: 36,
      height: 36,
      borderRadius: 10,
      background: "transparent",
      border: "none",
      color: "var(--muted)",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    };
    return (
      <aside
        style={{
          width: 56,
          flex: "none",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 16,
          gap: 14,
          background: "var(--panel)",
          borderRight: "1px solid var(--border)",
        }}
      >
        <BrandMark size={32} />
        <button style={railBtn} onClick={onToggleCollapsed} title="Розгорнути панель">
          <LnPanelLeft size={18} />
        </button>
        <button
          style={{ ...railBtn, background: "var(--surface)", border: "1px solid var(--border2)", color: "var(--accent)" }}
          onClick={onNewChat}
          title="Новий чат"
        >
          <LnPencil size={17} />
        </button>
        <button style={railBtn} onClick={onNewShipment} title="Нове постачання">
          <LnFolderPlus size={18} />
        </button>
        <button style={railBtn} onClick={onOpenSearch} title="Пошук">
          <LnSearch size={18} />
        </button>
      </aside>
    );
  }

  const navBtn: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 11,
    height: 40,
    padding: "0 12px",
    background: "transparent",
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    color: "var(--text)",
    fontWeight: 500,
    fontSize: 14,
    textAlign: "left",
    width: "100%",
  };

  return (
    <aside
      style={{
        width: 296,
        flex: "none",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--panel)",
        borderRight: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "16px 12px 12px 18px",
        }}
      >
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <BrandMark size={30} />
          <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: 1.5, color: "var(--text)" }}>
            ШТУРМАН
          </span>
        </div>
        <button
          onClick={onToggleCollapsed}
          title="Згорнути панель"
          style={{
            flex: "none",
            width: 32,
            height: 32,
            borderRadius: 9,
            background: "transparent",
            border: "none",
            color: "var(--muted)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <LnPanelLeft size={18} />
        </button>
      </div>

      <div style={{ flex: "none", display: "flex", flexDirection: "column", gap: 1, padding: "0 8px 8px" }}>
        <button style={{ ...navBtn, fontWeight: 600 }} onClick={onNewChat} className="nav-row">
          <span style={{ color: "var(--accent)", display: "flex" }}>
            <LnPencil size={18} />
          </span>
          Новий чат
        </button>
        <button style={navBtn} onClick={onNewShipment} className="nav-row">
          <span style={{ color: "var(--muted)", display: "flex" }}>
            <LnFolderPlus size={18} />
          </span>
          Нове постачання
        </button>
        <button style={navBtn} onClick={onOpenSearch} className="nav-row">
          <span style={{ color: "var(--muted)", display: "flex" }}>
            <LnSearch size={18} />
          </span>
          Пошук
        </button>
      </div>

      {/* Shipment selector */}
      <div style={{ flex: "none", height: 1, background: "var(--border)", margin: "2px 14px 8px" }} />
      <div style={{ flex: "none", padding: "0 12px 6px" }}>
        <label
          style={{
            display: "block",
            padding: "0 2px 6px",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.5,
            color: "var(--faint)",
            textTransform: "uppercase",
          }}
        >
          Постачання
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <select
              value={current.id}
              onChange={(e) => {
                if (e.target.value !== current.id) onSelectShipment(e.target.value);
              }}
              style={{
                width: "100%",
                height: 40,
                padding: "0 32px 0 12px",
                background: "var(--surface)",
                border: "1px solid var(--border2)",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text)",
                outline: "none",
                cursor: "pointer",
                appearance: "none",
                WebkitAppearance: "none",
                fontVariantNumeric: "tabular-nums",
                textOverflow: "ellipsis",
              }}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {shipmentLabel(w)}
                </option>
              ))}
            </select>
            <span
              style={{
                position: "absolute",
                right: 11,
                top: "50%",
                transform: "translateY(-50%)",
                pointerEvents: "none",
                color: "var(--muted)",
                display: "flex",
              }}
            >
              <LnChevronDown size={16} />
            </span>
          </div>
          <button
            onClick={onDeleteShipment}
            title="Видалити постачання"
            style={{
              flex: "none",
              width: 40,
              height: 40,
              borderRadius: 10,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              color: "var(--muted)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <LnTrash size={16} />
          </button>
        </div>
      </div>

      {/* Chat history for the selected shipment */}
      <div
        style={{
          flex: "none",
          padding: "6px 16px 4px",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.5,
          color: "var(--faint)",
          textTransform: "uppercase",
        }}
      >
        Чати
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 10px", display: "flex", flexDirection: "column", gap: 2, minHeight: 0 }}>
        {conversations.length === 0 ? (
          <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
            Немає чатів. «Новий чат» — почати.
          </div>
        ) : (
          conversations.map((c) => {
            const active = c.id === currentConversationId;
            return (
              <button
                key={c.id}
                onClick={() => onSelectConversation(c.id)}
                className="nav-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  background: active ? "var(--hover)" : "transparent",
                  border: "none",
                  padding: "9px 11px",
                  borderRadius: 9,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span style={{ flex: "none", color: "var(--muted)", display: "flex" }}>
                  <LnChat size={15} />
                </span>
                <span
                  className="ellipsis"
                  style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: active ? 600 : 400, color: "var(--text)" }}
                >
                  {c.title?.trim() || "Розмова"}
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}

function BrandMark({ size }: { size: number }) {
  return (
    <span
      style={{
        flex: "none",
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: "var(--accent)",
        color: "var(--accentTx)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 800,
        fontSize: Math.round(size * 0.53),
      }}
    >
      Ш
    </span>
  );
}
