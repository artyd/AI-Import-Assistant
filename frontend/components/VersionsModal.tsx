"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { FileVersion } from "@/lib/types";
import { IconUpload, IconSpinner } from "./icons";

interface Diff {
  field: string;
  a: unknown;
  b: unknown;
}

function fmt(v: unknown): string {
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

export function VersionsModal({
  workspaceId,
  fileId,
  onClose,
  onUploadVersion,
}: {
  workspaceId: string;
  fileId: string;
  onClose: () => void;
  onUploadVersion: (replacesFileId: string, files: FileList) => Promise<void>;
}) {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState<{ from: number; to: number; rows: Diff[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ versions: FileVersion[] }>(
        `/api/workspaces/${workspaceId}/files/${fileId}/history`
      );
      setVersions([...r.versions].sort((a, b) => a.version - b.version));
    } catch {
      setError("Не вдалося завантажити історію версій.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, fileId]);

  useEffect(() => {
    load();
  }, [load]);

  const latest = versions.find((v) => v.isLatest) ?? versions[versions.length - 1];

  const uploadNew = async (files: FileList) => {
    if (!latest) return;
    setBusy(true);
    setError(null);
    try {
      await onUploadVersion(latest.id, files);
      await load();
    } catch {
      setError("Не вдалося завантажити нову версію.");
    } finally {
      setBusy(false);
    }
  };

  const compare = async (v: FileVersion) => {
    if (!v.replacesFileId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ differences: Diff[] }>(
        `/api/workspaces/${workspaceId}/compare-versions`,
        { method: "POST", body: { fileIdA: v.id, fileIdB: v.replacesFileId } }
      );
      const prev = versions.find((x) => x.id === v.replacesFileId);
      setDiff({ from: prev?.version ?? v.version - 1, to: v.version, rows: r.differences });
    } catch {
      setError("Не вдалося порівняти версії (можливо, ще немає витягнутих полів).");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxWidth: "100%",
          maxHeight: "85vh",
          overflowY: "auto",
          background: "var(--surface)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow)",
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 600, fontFamily: "var(--font-display)" }}>Версії документа</div>
          <button className="btn-icon" onClick={onClose} aria-label="Закрити">✕</button>
        </div>

        <input
          ref={inputRef}
          type="file"
          hidden
          accept=".pdf,.docx,.xlsx,.csv,.png,.jpg,.jpeg"
          onChange={(e) => {
            if (e.target.files && e.target.files.length) uploadNew(e.target.files);
            e.target.value = "";
          }}
        />

        <button
          className="btn btn-primary"
          onClick={() => inputRef.current?.click()}
          disabled={busy || !latest}
        >
          {busy ? <IconSpinner size={15} /> : <IconUpload size={15} />} Завантажити нову версію
        </button>

        {error && <div style={{ color: "var(--err)", fontSize: 13 }}>{error}</div>}

        {loading ? (
          <div style={{ display: "grid", placeItems: "center", padding: 20 }}>
            <IconSpinner size={20} />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {versions.map((v) => (
              <div
                key={v.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "8px 10px",
                }}
              >
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>v{v.version}</span>
                {v.isLatest && <span className="badge ok" style={{ height: 20 }}>остання</span>}
                <span className="ellipsis" style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                  {v.name}
                </span>
                {v.replacesFileId && (
                  <button className="btn" style={{ height: 28 }} onClick={() => compare(v)} disabled={busy}>
                    Порівняти
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {diff && (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
              Зміни v{diff.from} → v{diff.to}
            </div>
            {diff.rows.length === 0 ? (
              <div style={{ color: "var(--muted)", fontSize: 13 }}>
                Структуровані поля збігаються — змін немає.
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={cellHead}>Поле</th>
                    <th style={cellHead}>Було</th>
                    <th style={cellHead}>Стало</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.rows.map((d) => (
                    <tr key={d.field}>
                      <td style={cell}>{d.field}</td>
                      <td style={cell}>{fmt(d.b)}</td>
                      <td style={cell}>{fmt(d.a)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const cellHead: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 6px",
  borderBottom: "1px solid var(--border)",
  color: "var(--muted)",
  fontWeight: 600,
};
const cell: React.CSSProperties = { padding: "4px 6px", borderBottom: "1px solid var(--border)" };
