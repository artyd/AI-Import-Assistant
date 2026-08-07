"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Workspace } from "@/lib/types";
import { IconChevronDown, IconPlus } from "./icons";

export function WorkspaceSelector({
  workspaces,
  current,
}: {
  workspaces: Workspace[];
  current: Workspace;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          justifyContent: "space-between",
          height: "auto",
          padding: "10px 12px",
          background: "var(--surface)",
        }}
      >
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, textAlign: "left" }}>
          <span style={{ fontWeight: 600 }}>№{current.number ?? "—"}</span>
          <span
            className="ellipsis"
            style={{ fontSize: 12, color: "var(--muted)", fontWeight: 400 }}
          >
            {current.supplier || "Без постачальника"}
          </span>
        </span>
        <IconChevronDown size={16} />
      </button>

      {open && (
        <div
          className="panel"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            zIndex: 30,
            background: "var(--menu)",
            boxShadow: "var(--shadow)",
            padding: 6,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {workspaces.map((w) => (
            <button
              key={w.id}
              onClick={() => {
                setOpen(false);
                if (w.id !== current.id) router.push(`/workspaces/${w.id}`);
              }}
              className="tree-row"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                border: "none",
                background:
                  w.id === current.id ? "var(--hover)" : "transparent",
                cursor: "pointer",
                color: "var(--text)",
                font: "inherit",
                borderRadius: 7,
              }}
            >
              <span style={{ fontWeight: 600 }}>№{w.number ?? "—"}</span>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                {w.supplier || "Без постачальника"}
              </span>
            </button>
          ))}
          <button
            onClick={() => {
              setOpen(false);
              router.push("/workspaces");
            }}
            className="tree-row"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "8px 10px",
              border: "none",
              borderTop: "1px solid var(--border)",
              marginTop: 4,
              background: "transparent",
              cursor: "pointer",
              color: "var(--text)",
              font: "inherit",
            }}
          >
            <IconPlus size={16} /> Усі поставки
          </button>
        </div>
      )}
    </div>
  );
}
