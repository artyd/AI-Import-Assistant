"use client";

import { useState } from "react";
import type { FileItem } from "@/lib/types";
import { LnRefresh } from "./LineIcons";

interface Props {
  files: FileItem[];
  onReindex: (file: FileItem) => void;
}

/**
 * Read-progress + problem-files strip for a shipment's file panel.
 *
 * Everything is derived from the live `files` state (fed by the file_status SSE
 * channel), so it needs no polling. It shows only when there is something worth
 * showing — files still being read, or files that need a human. This is the
 * per-shipment "прочитано X із Y" + "проблемні файли" surface (the user's #1
 * requirement: nothing is silently lost).
 */
export function IngestProgress({ files, onReindex }: Props) {
  const [open, setOpen] = useState(false);

  const latest = files.filter((f) => f.isLatest !== false);
  const total = latest.length;
  const read = latest.filter((f) => f.status === "ready").length;
  const pending = latest.filter((f) => f.status === "queued" || f.status === "indexing").length;
  const problems = latest.filter(
    (f) => f.status === "error" || f.extractionStatus === "unreadable"
  );

  // Nothing in flight and nothing broken → stay out of the way.
  if (pending === 0 && problems.length === 0) return null;

  const pct = total > 0 ? Math.round((read / total) * 100) : 0;

  return (
    <div
      style={{
        flex: "none",
        margin: "8px 12px 0",
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--surface)",
        fontSize: 12,
        color: "var(--text)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600 }}>
          Прочитано {read} із {total}
        </span>
        {pending > 0 && (
          <span style={{ color: "var(--muted)" }}>· {pending} в черзі</span>
        )}
        {problems.length > 0 && (
          <button
            onClick={() => setOpen((v) => !v)}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: "none",
              color: "var(--err)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {problems.length} потребують уваги {open ? "▲" : "▼"}
          </button>
        )}
      </div>

      {/* progress bar */}
      <div
        style={{
          marginTop: 8,
          height: 6,
          borderRadius: 4,
          background: "var(--border)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: pending > 0 ? "var(--accent)" : "var(--st-done)",
            transition: "width .3s ease",
          }}
        />
      </div>

      {open && problems.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {problems.map((f) => {
            const manual =
              f.extractionStatus === "unreadable" || f.errorReason === "needs_manual_entry";
            return (
              <div
                key={f.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 8,
                  background: "var(--chat)",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: manual ? "var(--st-idx)" : "var(--err)",
                    flex: "none",
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={f.errorReason ?? undefined}
                >
                  {f.name}
                  <span style={{ color: "var(--muted)", marginLeft: 6, fontSize: 11 }}>
                    {manual ? "потребує ручного вводу" : "помилка читання"}
                  </span>
                </span>
                <button
                  onClick={() => onReindex(f)}
                  title="Перечитати"
                  style={{
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    color: "var(--muted)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    padding: 4,
                  }}
                >
                  <LnRefresh size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
