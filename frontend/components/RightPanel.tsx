"use client";

import type { ReactNode } from "react";
import { LnChevronRight } from "./LineIcons";

export type RightTab = "files" | "journal" | "complete";

const TABS: { id: RightTab; label: string }[] = [
  { id: "files", label: "Файли" },
  { id: "journal", label: "Журнал" },
  { id: "complete", label: "Комплектність" },
];

interface Props {
  tab: RightTab;
  onTab: (t: RightTab) => void;
  onClose: () => void;
  badges?: Partial<Record<RightTab, number>>;
  files: ReactNode;
  journal: ReactNode;
  complete: ReactNode;
}

export function RightPanel({ tab, onTab, onClose, badges, files, journal, complete }: Props) {
  const content = tab === "files" ? files : tab === "journal" ? journal : complete;
  return (
    <aside
      style={{
        width: 344,
        flex: "none",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--panel)",
        borderLeft: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 10,
          height: "var(--header-h)",
          padding: "0 10px 0 18px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span style={{ flex: 1, fontWeight: 600, fontSize: 14, color: "var(--text)" }}>
          Робоча панель
        </span>
        <button
          onClick={onClose}
          title="Закрити панель"
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
          <LnChevronRight size={17} />
        </button>
      </div>

      <div
        style={{
          flex: "none",
          display: "flex",
          gap: 2,
          margin: "10px 12px 0",
          padding: 3,
          background: "var(--hover)",
          borderRadius: 11,
        }}
      >
        {TABS.map((t) => {
          const on = tab === t.id;
          const badge = badges?.[t.id];
          return (
            <button
              key={t.id}
              onClick={() => onTab(t.id)}
              style={{
                flex: 1,
                height: 34,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                border: "none",
                borderRadius: 9,
                cursor: "pointer",
                font: "inherit",
                fontWeight: 600,
                fontSize: 12.5,
                color: on ? "var(--text)" : "var(--muted)",
                background: on ? "var(--surface)" : "transparent",
                boxShadow: on ? "var(--elev-1)" : "none",
                transition: "background .15s, color .15s",
              }}
            >
              {t.label}
              {badge != null && badge > 0 && (
                <span
                  style={{
                    minWidth: 16,
                    height: 16,
                    padding: "0 5px",
                    borderRadius: 9,
                    background: on ? "var(--accentSoft)" : "var(--border)",
                    color: on ? "var(--accent)" : "var(--muted)",
                    fontSize: 10.5,
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {content}
      </div>
    </aside>
  );
}
