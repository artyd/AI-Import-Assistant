"use client";

import { useRef, useState } from "react";
import type { FileItem, Folder } from "@/lib/types";
import { toUiStatus } from "@/lib/types";
import { folderLabel } from "@/lib/folderLabels";
import { FileTree } from "./FileTree";
import {
  LnFile,
  LnFileDoc,
  LnFileImg,
  LnFilePdf,
  LnFileSheet,
  LnFolder,
  LnGrid,
  LnList,
  LnSearch,
  LnUpload,
} from "./LineIcons";

const UPLOAD_ACCEPT = ".pdf,.docx,.xlsx,.csv,.png,.jpg,.jpeg";

interface Props {
  workspaceNumber: string | null;
  folders: Folder[];
  files: FileItem[];
  onUpload: (folderId: string | null, files: FileList) => void;
  onCreateFolder: () => void;
  onRenameFile: (file: FileItem, name: string) => void;
  onDeleteFile: (file: FileItem) => void;
  onVersions: (file: FileItem) => void;
  onMoveFile: (file: FileItem, folderId: string) => void;
  onReindex: (file: FileItem) => void;
  onPreview: (file: FileItem) => void;
}

function fileIcon(name: string) {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return <LnFilePdf size={22} />;
  if (n.endsWith(".xlsx") || n.endsWith(".csv") || n.endsWith(".xls")) return <LnFileSheet size={22} />;
  if (n.endsWith(".docx") || n.endsWith(".doc")) return <LnFileDoc size={22} />;
  if (n.endsWith(".png") || n.endsWith(".jpg") || n.endsWith(".jpeg")) return <LnFileImg size={22} />;
  return <LnFile size={22} />;
}

const STATUS_COLOR: Record<string, string> = {
  done: "var(--st-done)",
  indexing: "var(--st-idx)",
  queued: "var(--st-queue)",
  error: "var(--err)",
};

export function FilesTab(props: Props) {
  const { workspaceNumber, folders, files, onUpload, onCreateFolder, onPreview } = props;
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"list" | "grid">("list");
  const [rootDrag, setRootDrag] = useState(false);
  const rootInputRef = useRef<HTMLInputElement>(null);

  const q = search.trim().toLowerCase();
  const gridFiles = files
    .filter((f) => f.isLatest !== false && (!q || f.name.toLowerCase().includes(q)))
    .map((f) => ({
      ...f,
      folderName: (() => {
        const fo = folders.find((x) => x.id === f.folderId);
        return fo ? folderLabel(fo.name) : "Корінь постачання";
      })(),
    }));

  const viewBtn = (active: boolean): React.CSSProperties => ({
    width: 30,
    height: 30,
    borderRadius: 8,
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "var(--accentSoft)" : "transparent",
    color: active ? "var(--accent)" : "var(--muted)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <input
        ref={rootInputRef}
        type="file"
        multiple
        hidden
        accept={UPLOAD_ACCEPT}
        onChange={(e) => {
          if (e.target.files && e.target.files.length) onUpload(null, e.target.files);
          e.target.value = "";
        }}
      />

      <div style={{ flex: "none", padding: "12px 12px 8px" }}>
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", display: "flex" }}>
            <LnSearch size={15} />
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Пошук файлів"
            style={{
              width: "100%",
              height: 38,
              padding: "0 12px 0 34px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: 13,
              color: "var(--text)",
              outline: "none",
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            onClick={onCreateFolder}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              height: 36,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 9,
              color: "var(--text)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            <LnFolder size={15} /> Тека
          </button>
          <button
            onClick={() => rootInputRef.current?.click()}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              height: 36,
              background: "var(--accent)",
              border: "none",
              borderRadius: 9,
              color: "var(--accentTx)",
              fontWeight: 600,
              fontSize: 12.5,
              cursor: "pointer",
            }}
          >
            <LnUpload size={15} /> Завантажити
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <span style={{ flex: 1, fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: "var(--faint)", textTransform: "uppercase" }}>
            Документи
          </span>
          <button style={viewBtn(view === "list")} onClick={() => setView("list")} title="Список">
            <LnList size={15} />
          </button>
          <button style={viewBtn(view === "grid")} onClick={() => setView("grid")} title="Сітка">
            <LnGrid size={15} />
          </button>
        </div>
      </div>

      <div
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes("Files")) {
            e.preventDefault();
            setRootDrag(true);
          }
        }}
        onDragLeave={() => setRootDrag(false)}
        onDrop={(e) => {
          if (Array.from(e.dataTransfer.types).includes("Files")) {
            e.preventDefault();
            setRootDrag(false);
            if (e.dataTransfer.files.length) onUpload(null, e.dataTransfer.files);
          }
        }}
        style={{
          flex: "none",
          margin: "0 12px",
          padding: "8px 8px 4px",
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontSize: 11.5,
          color: "var(--muted)",
          borderRadius: 9,
          background: rootDrag ? "var(--accentSoft)" : "transparent",
        }}
      >
        <LnFolder size={13} /> Shipment_{workspaceNumber ?? "—"}
      </div>

      {view === "list" ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "0 6px 8px" }}>
          <FileTree
            folders={folders}
            files={files}
            search={search}
            onUpload={onUpload}
            onRenameFile={props.onRenameFile}
            onDeleteFile={props.onDeleteFile}
            onVersions={props.onVersions}
            onMoveFile={props.onMoveFile}
            onReindex={props.onReindex}
            onPreview={props.onPreview}
          />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 12px 16px", minHeight: 0 }}>
          {gridFiles.length === 0 ? (
            <div style={{ padding: "22px 16px", textAlign: "center", fontSize: 12.5, color: "var(--muted)" }}>
              Немає документів.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 8 }}>
              {gridFiles.map((g) => {
                const st = toUiStatus(g.status);
                return (
                  <button
                    key={g.id}
                    onClick={() => onPreview(g)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      padding: 12,
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 12,
                      cursor: "pointer",
                      textAlign: "left",
                      minWidth: 0,
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--muted)", display: "flex" }}>{fileIcon(g.name)}</span>
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: "50%",
                          background: st === "queued" ? "transparent" : STATUS_COLOR[st],
                          border: st === "queued" ? "1.5px solid var(--st-queue)" : "none",
                        }}
                      />
                    </span>
                    <span className="ellipsis" style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>
                      {g.name}
                    </span>
                    <span className="ellipsis" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                      {g.folderName}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
