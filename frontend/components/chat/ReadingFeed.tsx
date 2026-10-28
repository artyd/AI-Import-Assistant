"use client";

import { useEffect, useState } from "react";
import type { FileItem, IngestEvent } from "@/lib/types";
import { readingState } from "@/lib/files/journal";
import { IconCheck, IconFile, IconFolder, IconSpinner } from "../ui/icons";

/**
 * Live «Штурман читає документи» feed above the chat input (spec 007): every
 * file is read in full, and only then filed — this shows it happening:
 * "Читаю …", "Прочитано …", "Кладу → Митниця / A", and the batch summary.
 */
export function ReadingFeed({ events, files }: { events: IngestEvent[]; files: FileItem[] }) {
  // Re-evaluate the linger window without new events.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const [open, setOpen] = useState(true);
  const s = readingState(events, files, Math.max(now, Date.now()));
  if (!s.active) return null;
  const reading = s.read < s.total;

  return (
    <div
      data-testid="reading-feed"
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "var(--card)",
        marginBottom: 8,
        fontSize: 13,
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          border: "none",
          background: "transparent",
          color: "var(--text)",
          font: "inherit",
          fontWeight: 600,
          padding: "8px 12px",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {reading ? <IconSpinner size={14} /> : <IconCheck size={14} />}
        <span style={{ flex: 1 }}>
          {reading ? "Штурман читає документи" : "Штурман дочитав документи"} · прочитано {s.read} з {s.total}
        </span>
        <span style={{ color: "var(--muted)", fontWeight: 400 }}>{open ? "згорнути" : "розгорнути"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 3 }}>
          {s.lines.map((e) => (
            <div
              key={e.id}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                color: e.kind === "warn" || e.kind === "error" ? "var(--warn)" : e.kind === "summary" ? "var(--text)" : "var(--muted)",
                fontWeight: e.kind === "summary" ? 600 : 400,
              }}
            >
              <span style={{ flex: "none", paddingTop: 2 }}>
                {e.kind === "file" ? <IconFolder size={12} /> : e.kind === "done" || e.kind === "summary" ? <IconCheck size={12} /> : <IconFile size={12} />}
              </span>
              <span style={{ wordBreak: "break-word" }}>{e.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
