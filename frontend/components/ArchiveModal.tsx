"use client";

// Archive of past consolidated-cargo analyses — a port of the prototype's archive
// (ШТУРМАН.dc.html lines ~844–869). Lists GET /api/analyses/archive and allows
// deleting a record via DELETE /api/analyses/archive/:id. Exposed both as an
// embeddable list (ArchiveList — used in the Збірний working panel) and a modal.

import { useCallback, useEffect, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { api, downloadBlob } from "@/lib/api";
import type { ArchiveRecord } from "@/lib/types";
import { IconSpinner } from "./icons";
import { Markdown } from "./Markdown";

function fmtPayable(p: number | string): string {
  const n = typeof p === "string" ? Number(p) : p;
  if (Number.isFinite(n)) return Math.round(n).toLocaleString("uk-UA") + " $";
  return String(p);
}

// Full-screen preview of a stored analysis, rendered from the same per-product
// Markdown the chat shows (GET /api/analyses/:id/markdown).
function AnalysisPreviewModal({
  rec,
  onClose,
}: {
  rec: ArchiveRecord;
  onClose: () => void;
}) {
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!rec.analysisId) {
      setError("Аналіз більше недоступний.");
      return;
    }
    api<{ markdown: string }>(`/api/analyses/${rec.analysisId}/markdown`)
      .then((r) => alive && setMd(r.markdown))
      .catch(() => alive && setError("Не вдалося завантажити аналіз."));
    return () => {
      alive = false;
    };
  }, [rec.analysisId]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
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
          width: 900,
          maxWidth: "100%",
          maxHeight: "88vh",
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
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ flex: 1, fontWeight: 600, fontSize: 15, color: "var(--text)" }}>
            {rec.source} · лист «{rec.sheet}»
          </span>
          {rec.analysisId ? (
            <button
              className="btn"
              onClick={() =>
                void downloadBlob(
                  `/api/analyses/${rec.analysisId}/xlsx`,
                  `analysis-${rec.sheet || "manifest"}.xlsx`
                ).catch(() => alert("Не вдалося завантажити звіт."))
              }
            >
              Завантажити Excel
            </button>
          ) : null}
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
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 22px" }}>
          {error ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--err)", fontSize: 13 }}>{error}</div>
          ) : md === null ? (
            <div style={{ display: "grid", placeItems: "center", padding: 48 }}>
              <IconSpinner size={22} />
            </div>
          ) : (
            <Markdown>{md}</Markdown>
          )}
        </div>
      </div>
    </div>
  );
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
// Icon-only action button revealed on card hover.
function HoverAction({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: (e: ReactMouseEvent) => void;
  title: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 30,
        height: 30,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        color: danger ? "var(--err)" : "var(--text)",
        cursor: "pointer",
        borderRadius: 8,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "var(--shadow)",
      }}
    >
      {children}
    </button>
  );
}

// One archive card: the report itself is visible (a clipped live preview); the
// action bar (превью / завантажити / видалити) fades in on hover.
function ArchiveCard({
  rec,
  onPreview,
  onDownload,
  onRemove,
}: {
  rec: ArchiveRecord;
  onPreview: () => void;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const [md, setMd] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!rec.analysisId) return;
    api<{ markdown: string }>(`/api/analyses/${rec.analysisId}/markdown`)
      .then((r) => alive && setMd(r.markdown))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [rec.analysisId]);

  const canOpen = Boolean(rec.analysisId);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => canOpen && onPreview()}
      style={{
        position: "relative",
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        overflow: "hidden",
        cursor: canOpen ? "pointer" : "default",
      }}
    >
      {/* Header strip */}
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {rec.source} · лист «{rec.sheet}»
          </div>
          {rec.hasHigh ? (
            <span style={{ flex: "none", fontSize: 10.5, fontWeight: 600, color: "var(--err)", background: "var(--errBg)", borderRadius: 6, padding: "3px 8px" }}>
              ризик
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
          {rec.itemCount} позицій · до сплати {fmtPayable(rec.payable)} · {fmtDate(rec.createdAt)}
        </div>
      </div>

      {/* The report itself — a clipped live preview with a fade at the bottom. */}
      <div style={{ position: "relative", maxHeight: 240, overflow: "hidden" }}>
        <div style={{ padding: "6px 14px 14px", fontSize: 12 }}>
          {rec.analysisId ? (
            failed ? (
              <div style={{ color: "var(--err)", fontSize: 12, padding: "12px 0" }}>Не вдалося завантажити звіт.</div>
            ) : md === null ? (
              <div style={{ display: "grid", placeItems: "center", padding: 28 }}>
                <IconSpinner size={18} />
              </div>
            ) : (
              <Markdown>{md}</Markdown>
            )
          ) : (
            <div style={{ color: "var(--muted)", fontSize: 12, padding: "12px 0", lineHeight: 1.5 }}>
              Звіт цього запису недоступний (створено до оновлення). Доступне лише видалення.
            </div>
          )}
        </div>
        {/* bottom fade */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 48,
            pointerEvents: "none",
            background: "linear-gradient(to bottom, transparent, var(--card))",
          }}
        />
      </div>

      {/* Hover action bar (top-right). */}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          display: "flex",
          gap: 6,
          opacity: hover ? 1 : 0,
          transform: hover ? "translateY(0)" : "translateY(-4px)",
          transition: "opacity .15s ease, transform .15s ease",
          pointerEvents: hover ? "auto" : "none",
        }}
      >
        {rec.analysisId ? (
          <HoverAction
            title="Переглянути"
            onClick={(e) => {
              e.stopPropagation();
              onPreview();
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </HoverAction>
        ) : null}
        {rec.analysisId ? (
          <HoverAction
            title="Завантажити Excel"
            onClick={(e) => {
              e.stopPropagation();
              onDownload();
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
          </HoverAction>
        ) : null}
        <HoverAction
          title="Видалити"
          danger
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </HoverAction>
      </div>
    </div>
  );
}

export function ArchiveList() {
  const [records, setRecords] = useState<ArchiveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArchiveRecord | null>(null);

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
    if (!window.confirm("Видалити аналіз з архіву?")) return;
    const prev = records;
    setRecords((rs) => rs.filter((x) => x.id !== rec.id));
    try {
      await api(`/api/analyses/archive/${rec.id}`, { method: "DELETE" });
    } catch {
      setRecords(prev);
      alert("Не вдалося видалити запис.");
    }
  };

  const download = (rec: ArchiveRecord) => {
    if (!rec.analysisId) return;
    void downloadBlob(
      `/api/analyses/${rec.analysisId}/xlsx`,
      `analysis-${rec.sheet || "manifest"}.xlsx`
    ).catch(() => alert("Не вдалося завантажити звіт."));
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
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {records.map((rec) => (
            <ArchiveCard
              key={rec.id}
              rec={rec}
              onPreview={() => setPreview(rec)}
              onDownload={() => download(rec)}
              onRemove={() => remove(rec)}
            />
          ))}
        </div>
      )}
      {preview ? <AnalysisPreviewModal rec={preview} onClose={() => setPreview(null)} /> : null}
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
