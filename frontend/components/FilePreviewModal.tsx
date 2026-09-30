"use client";

import { useEffect, useState } from "react";
import type { FileItem } from "@/lib/types";
import { getToken, downloadBlob, handleUnauthorized } from "@/lib/api";
import { IconSpinner, IconDownload } from "./icons";

interface Props {
  workspaceId: string;
  file: FileItem;
  onClose: () => void;
}

export function FilePreviewModal({ workspaceId, file, onClose }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const contentPath = `/api/workspaces/${workspaceId}/files/${file.id}/content`;
  const isPdf = file.type === "pdf";
  const previewable = file.type === "image" || isPdf;

  useEffect(() => {
    if (!previewable) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const token = getToken();
        const res = await fetch(contentPath, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
          handleUnauthorized(contentPath, res.status);
          throw new Error("fetch_failed");
        }
        const raw = await res.blob();
        if (cancelled) return;
        // Force the MIME type we render: a PDF blob is ALWAYS application/pdf,
        // so a mislabelled HTML/SVG payload can never render as a same-origin
        // document. Images are only ever shown via <img>, which runs no scripts.
        const blob = isPdf ? new Blob([raw], { type: "application/pdf" }) : raw;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [contentPath, previewable, isPdf]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.55)",
        display: "grid",
        placeItems: "center",
        padding: 24,
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{
          width: "100%",
          maxWidth: 980,
          height: "88vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
          boxShadow: "var(--shadow)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            flex: "none",
          }}
        >
          <span
            className="ellipsis"
            style={{ flex: 1, minWidth: 0, fontWeight: 600 }}
            title={file.name}
          >
            {file.name}
          </span>
          <button
            className="btn"
            style={{ height: 32, padding: "0 12px" }}
            onClick={() => void downloadBlob(contentPath, file.name)}
          >
            <IconDownload size={15} /> Завантажити
          </button>
          <button
            className="btn-icon"
            onClick={onClose}
            aria-label="Закрити"
            title="Закрити"
            style={{ fontSize: 18, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            placeItems: "center",
            background: "var(--card)",
            overflow: "auto",
          }}
        >
          {!previewable ? (
            <div style={{ textAlign: "center", color: "var(--muted)", padding: 24 }}>
              <p style={{ margin: "0 0 12px" }}>
                Попередній перегляд для цього типу файлів недоступний.
              </p>
              <button
                className="btn btn-primary"
                onClick={() => void downloadBlob(contentPath, file.name)}
                style={{ margin: "0 auto" }}
              >
                <IconDownload size={16} /> Завантажити файл
              </button>
            </div>
          ) : error ? (
            <div style={{ color: "var(--err)", padding: 24 }}>
              Не вдалося завантажити файл для перегляду.
            </div>
          ) : !url ? (
            <div style={{ color: "var(--muted)" }}>
              <IconSpinner size={24} />
            </div>
          ) : file.type === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={file.name}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          ) : (
            // PDF via <object type="application/pdf"> instead of an unsandboxed
            // iframe: only the browser's PDF viewer renders it (a sandboxed
            // iframe would block that viewer). CSP: object-src 'self' blob:.
            <object
              data={url}
              type="application/pdf"
              aria-label={file.name}
              data-testid="pdf-preview"
              style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
            >
              <div style={{ textAlign: "center", color: "var(--muted)", padding: 24 }}>
                <p style={{ margin: "0 0 12px" }}>Браузер не може показати PDF тут.</p>
                <button
                  className="btn btn-primary"
                  onClick={() => void downloadBlob(contentPath, file.name)}
                  style={{ margin: "0 auto" }}
                >
                  <IconDownload size={16} /> Завантажити файл
                </button>
              </div>
            </object>
          )}
        </div>
      </div>
    </div>
  );
}
