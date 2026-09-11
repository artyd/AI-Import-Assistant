"use client";

import { useEffect, useRef, useState } from "react";
import type { Workspace, WorkspaceStatus } from "@/lib/types";
import { NotificationsBell } from "./NotificationsBell";
import {
  LnCheck,
  LnLock,
  LnMoon,
  LnPanelRight,
  LnPencil,
  LnSearch,
  LnSoundOff,
  LnSoundOn,
  LnSun,
} from "./LineIcons";

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  active: "Активна",
  draft: "Чернетка",
  done: "Готово",
  docs_in_progress: "Документи в роботі",
  docs_complete: "Документи повні",
  customs_ready: "Готово до митниці",
};
const STATUS_OK = new Set<WorkspaceStatus>(["done", "customs_ready", "docs_complete"]);
const STATUS_WARN = new Set<WorkspaceStatus>(["docs_in_progress"]);

function statusColors(status: WorkspaceStatus): { bg: string; fg: string } {
  if (STATUS_OK.has(status)) return { bg: "var(--okBg)", fg: "var(--ok)" };
  if (STATUS_WARN.has(status)) return { bg: "var(--warnBg)", fg: "var(--warn)" };
  if (status === "active") return { bg: "var(--accentSoft)", fg: "var(--accent)" };
  return { bg: "var(--hover)", fg: "var(--muted)" };
}

export interface CompletenessStep {
  label: string;
  ok: boolean;
}

interface Props {
  workspace: Workspace;
  steps: CompletenessStep[];
  rightOpen: boolean;
  onToggleRight: () => void;
  onTogglePalette: () => void;
  sound: boolean;
  onToggleSound: () => void;
  onLock: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onSaveSupplier: (supplier: string) => void;
}

export function TopBar({
  workspace,
  steps,
  rightOpen,
  onToggleRight,
  onTogglePalette,
  sound,
  onToggleSound,
  onLock,
  theme,
  onToggleTheme,
  onSaveSupplier,
}: Props) {
  const pill = statusColors(workspace.status);
  const [editing, setEditing] = useState(false);
  const [supplierText, setSupplierText] = useState(workspace.supplier ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSupplierText(workspace.supplier ?? "");
  }, [workspace.supplier]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit() {
    setEditing(false);
    const next = supplierText.trim();
    if (next !== (workspace.supplier ?? "")) onSaveSupplier(next);
  }

  const iconBtn: React.CSSProperties = {
    flex: "none",
    width: 36,
    height: 36,
    borderRadius: 10,
    background: "transparent",
    border: "1px solid var(--border)",
    color: "var(--muted)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  return (
    <div
      style={{
        flex: "none",
        height: "var(--header-h)",
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 18px",
        borderBottom: "1px solid var(--border)",
        background: "var(--chat)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
        <span style={{ flex: "none", width: 9, height: 9, borderRadius: "50%", background: pill.fg }} />
        <span
          style={{
            fontWeight: 600,
            fontSize: 14.5,
            color: "var(--text)",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          Постачання №{workspace.number ?? "—"}
        </span>

        {editing ? (
          <input
            ref={inputRef}
            value={supplierText}
            onChange={(e) => setSupplierText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setSupplierText(workspace.supplier ?? "");
                setEditing(false);
              }
            }}
            onBlur={commit}
            placeholder="Постачальник"
            style={{
              height: 28,
              width: 170,
              padding: "0 9px",
              background: "var(--surface)",
              border: "1px solid var(--accent)",
              borderRadius: 8,
              fontSize: 13,
              color: "var(--text)",
              outline: "none",
            }}
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            title="Змінити постачальника"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              border: "none",
              padding: "3px 7px",
              borderRadius: 8,
              fontSize: 13,
              color: "var(--muted)",
              cursor: "pointer",
              maxWidth: 220,
            }}
          >
            <span className="ellipsis" style={{ minWidth: 0 }}>
              · {workspace.supplier || "Без постачальника"}
            </span>
            <span style={{ opacity: 0.6, display: "flex", flex: "none" }}>
              <LnPencil size={12} />
            </span>
          </button>
        )}

        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 11px 4px 9px",
            borderRadius: 20,
            background: pill.bg,
            color: pill.fg,
            fontSize: 11.5,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: pill.fg }} />
          {STATUS_LABEL[workspace.status] ?? workspace.status}
        </span>

        {/* Completeness steps — one dot per checklist requirement. */}
        {steps.length > 0 && (
          <div
            title="Комплектність пакета"
            style={{ display: "flex", alignItems: "center", marginLeft: 4 }}
          >
            {steps.map((st, i) => (
              <span key={i} style={{ display: "flex", alignItems: "center" }}>
                <span
                  title={st.label}
                  style={{
                    flex: "none",
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    background: st.ok ? "var(--accent)" : "transparent",
                    border: `1.5px solid ${st.ok ? "var(--accent)" : "var(--border2)"}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--accentTx)",
                  }}
                >
                  {st.ok && <LnCheck size={8} strokeWidth={4} />}
                </span>
                {i < steps.length - 1 && (
                  <span
                    style={{
                      flex: "none",
                      width: 14,
                      height: 2,
                      background: st.ok ? "var(--accent)" : "var(--border2)",
                    }}
                  />
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: 1 }} />

      <button
        onClick={onTogglePalette}
        title="Команди (Ctrl/⌘K)"
        style={{
          flex: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          height: 36,
          padding: "0 10px 0 12px",
          borderRadius: 10,
          background: "transparent",
          border: "1px solid var(--border)",
          color: "var(--muted)",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        <LnSearch size={15} />
        <span
          style={{
            fontWeight: 600,
            fontSize: 11,
            padding: "2px 6px",
            borderRadius: 6,
            background: "var(--hover)",
          }}
        >
          ⌘K
        </span>
      </button>

      <button
        onClick={onToggleRight}
        title="Робоча панель"
        style={{
          flex: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          height: 36,
          padding: "0 12px",
          borderRadius: 10,
          background: rightOpen ? "var(--accentSoft)" : "transparent",
          border: `1px solid ${rightOpen ? "transparent" : "var(--border)"}`,
          color: rightOpen ? "var(--accent)" : "var(--muted)",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        <LnPanelRight size={17} />
        Панель
      </button>

      <NotificationsBell />

      <button style={iconBtn} onClick={onToggleTheme} title="Тема оформлення" aria-label="Тема оформлення">
        {theme === "dark" ? <LnSun size={17} /> : <LnMoon size={16} />}
      </button>
      <button
        style={iconBtn}
        onClick={onToggleSound}
        title={sound ? "Звук увімкнено" : "Звук вимкнено"}
        aria-label="Звук"
      >
        {sound ? <LnSoundOn size={17} /> : <LnSoundOff size={17} />}
      </button>
      <button style={iconBtn} onClick={onLock} title="Заблокувати (вийти)" aria-label="Заблокувати">
        <LnLock size={16} />
      </button>
    </div>
  );
}
