"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { ProblemFile } from "@/lib/types";

/** Alert-triangle glyph (inline to avoid a new icon dependency). */
function AlertIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

/**
 * Cross-shipment "проблемні файли" surface: every file that failed to read or is
 * flagged for manual entry, across all of the user's shipments. Backs the user's
 * "сквозной список проблемних файлів" requirement — a single place to see what
 * needs a human anywhere. Polls lightly; opening a row jumps to that shipment.
 */
export function ProblemFilesButton() {
  const { user } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<ProblemFile[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = () =>
      api<{ files: ProblemFile[] }>("/api/problem-files")
        .then((r) => !cancelled && setItems(r.files))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [user]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!user || items.length === 0) return null;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn-icon"
        onClick={() => setOpen((o) => !o)}
        aria-label="Проблемні файли"
        title="Проблемні файли"
        style={{ position: "relative", color: "var(--err)" }}
      >
        <AlertIcon size={18} />
        <span
          style={{
            position: "absolute",
            top: 2,
            right: 2,
            minWidth: 15,
            height: 15,
            padding: "0 3px",
            borderRadius: 999,
            background: "var(--err)",
            color: "#fff",
            fontSize: 10,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {items.length > 9 ? "9+" : items.length}
        </span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            width: 360,
            maxHeight: 420,
            overflowY: "auto",
            background: "var(--menu)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow)",
            zIndex: 50,
            padding: 8,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", padding: "6px 10px 8px", textTransform: "uppercase", letterSpacing: 0.4 }}>
            Проблемні файли ({items.length})
          </div>
          {items.map((f) => {
            const manual = f.extractionStatus === "unreadable" || f.errorReason === "needs_manual_entry";
            return (
              <div
                key={f.id}
                className="notif-row"
                onClick={() => {
                  setOpen(false);
                  router.push(`/workspaces/${f.workspaceId}`);
                }}
                style={{ padding: "8px 10px", borderRadius: 8, fontSize: 13, cursor: "pointer" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: manual ? "var(--st-idx)" : "var(--err)" }}
                  />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.name}
                  </span>
                </div>
                <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>
                  Постачання №{f.workspaceNumber} · {manual ? "потребує ручного вводу" : "помилка читання"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
