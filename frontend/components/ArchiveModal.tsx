"use client";

// Archive of past consolidated-cargo analyses — a port of the prototype's archive
// (ШТУРМАН.dc.html lines ~844–869). Lists GET /api/analyses/archive and allows
// deleting a record via DELETE /api/analyses/archive/:id. Exposed both as an
// embeddable list (ArchiveList — used in the Збірний working panel) and a modal.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ArchiveRecord } from "@/lib/types";
import { IconSpinner } from "./icons";

function fmtPayable(p: number | string): string {
  const n = typeof p === "string" ? Number(p) : p;
  if (Number.isFinite(n)) return Math.round(n).toLocaleString("uk-UA") + " $";
  return String(p);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    d.toLocaleDateString("uk-UA") +
    " " +
    d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })
  );
}

// Embeddable archive list (no overlay/header). Used in the working panel.
export function ArchiveList() {
  const [records, setRecords] = useState<ArchiveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ records: ArchiveRecord[] }>(`/api/analyses/archive`);
      setRecords(r.records);
    } catch {
      setError("Не вдалося завантажити архів.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (rec: ArchiveRecord) => {
    if (!window.confirm("Видалити запис з архіву?")) return;
    const prev = records;
    setRecords((rs) => rs.filter((x) => x.id !== rec.id));
    try {
      await api(`/api/analyses/archive/${rec.id}`, { method: "DELETE" });
    } catch {
      setRecords(prev);
      alert("Не вдалося видалити запис.");
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px 18px" }}>
      {loading ? (
        <div style={{ display: "grid", placeItems: "center", padding: 36 }}>
          <IconSpinner size={22} />
        </div>
      ) : error ? (
        <div style={{ padding: "36px 16px", textAlign: "center", color: "var(--err)", fontSize: 13 }}>{error}</div>
      ) : records.length === 0 ? (
        <div style={{ padding: "36px 16px", textAlign: "center", color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
          Архів порожній. Зробіть аналіз збірного вантажу — результати зберігатимуться тут.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {records.map((rec) => (
            <div
              key={rec.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 14px",
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 12,
              }}
            >
              <span
                style={{
                  flex: "none",
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: "var(--accentSoft)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--accent)",
                }}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <path d="M7 15l3-4 3 3 4-6" />
                </svg>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                  {rec.source} · лист «{rec.sheet}»
                </div>
                <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                  {rec.item_count} позицій · до сплати {fmtPayable(rec.payable)} · {fmtDate(rec.created_at)}
                </div>
              </div>
              {rec.has_high ? (
                <span
                  style={{
                    flex: "none",
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: "var(--err)",
                    background: "var(--errBg)",
                    borderRadius: 6,
                    padding: "3px 8px",
                  }}
                >
                  ризик
                </span>
              ) : null}
              <button
                onClick={() => remove(rec)}
                title="Видалити"
                style={{
                  flex: "none",
                  width: 30,
                  height: 30,
                  border: "none",
                  background: "transparent",
                  color: "var(--muted)",
                  cursor: "pointer",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Modal wrapper (kept for any standalone use).
export function ArchiveModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(10,10,14,.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "100%",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 18,
          boxShadow: "var(--shadow)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "16px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ flex: 1, fontWeight: 600, fontSize: 16, color: "var(--text)" }}>Архів аналізів</span>
          <button
            onClick={onClose}
            title="Закрити"
            style={{
              flex: "none",
              width: 30,
              height: 30,
              border: "none",
              background: "transparent",
              color: "var(--muted)",
              cursor: "pointer",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <ArchiveList />
      </div>
    </div>
  );
}
