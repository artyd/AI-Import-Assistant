"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { NotificationItem } from "@/lib/types";
import { IconBell } from "./icons";

// Per-type badge (label + colour var). Unknown types render without a tag.
const TYPE_TAG: Record<string, { label: string; color: string }> = {
  reconcile_ready: { label: "Звірка", color: "var(--accent)" },
  risk_alert: { label: "Ризик", color: "var(--err)" },
  checklist_incomplete: { label: "Документи", color: "var(--warn)" },
};

export function NotificationsBell() {
  const { user } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = () =>
      api<{ notifications: NotificationItem[] }>("/api/notifications")
        .then((r) => !cancelled && setItems(r.notifications))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000); // light polling
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

  if (!user) return null;
  const unread = items.filter((n) => !n.read).length;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn-icon"
        onClick={() => setOpen((o) => !o)}
        aria-label="Сповіщення"
        title="Сповіщення"
        style={{ position: "relative" }}
      >
        <IconBell size={18} />
        {unread > 0 && (
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
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            width: 320,
            maxHeight: 380,
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
          {items.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 13, padding: 12 }}>
              Сповіщень немає.
            </div>
          ) : (
            items.map((n) => {
              const tag = TYPE_TAG[n.type];
              const clickable = !!n.workspace_id;
              return (
                <div
                  key={n.id}
                  onClick={
                    clickable
                      ? () => {
                          setOpen(false);
                          router.push(`/workspaces/${n.workspace_id}`);
                        }
                      : undefined
                  }
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    fontSize: 13,
                    cursor: clickable ? "pointer" : "default",
                  }}
                  className={clickable ? "notif-row" : undefined}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {tag && (
                      <span
                        style={{
                          flex: "none",
                          fontSize: 10,
                          fontWeight: 700,
                          color: tag.color,
                          border: `1px solid ${tag.color}`,
                          borderRadius: 5,
                          padding: "1px 5px",
                          textTransform: "uppercase",
                          letterSpacing: 0.3,
                        }}
                      >
                        {tag.label}
                      </span>
                    )}
                    <span>{n.message}</span>
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 11, fontFamily: "var(--font-mono)", marginTop: 2 }}>
                    {new Date(n.created_at).toLocaleString()}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
