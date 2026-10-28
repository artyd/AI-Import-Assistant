"use client";

import { useMemo, useRef, useState } from "react";
import type { FileItem, Folder } from "@/lib/types";
import { toUiStatus } from "@/lib/types";
import { folderLabel } from "@/lib/folderLabels";
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconPlus,
  IconEdit,
  IconTrash,
  IconHistory,
  IconCheck,
  IconRefresh,
} from "../ui/icons";

import { UPLOAD_ACCEPT } from "@/lib/files/policy";
import { buildFolderTree, flattenTree, folderPathLabel, subtreeIds, type FolderNode } from "@/lib/files/folderTree";

/** The key of files without a folder (shown in the virtual «Інбокс» folder). */
const INBOX_ID = "__none__";

/** A file row in a folder: its own place, or a link (a document about several products). */
interface Placed {
  file: FileItem;
  linked: boolean;
}
interface Props {
  folders: Folder[];
  files: FileItem[];
  search: string;
  onUpload: (folderId: string | null, files: FileList) => void;
  onRenameFile: (file: FileItem, name: string) => void;
  onDeleteFile: (file: FileItem) => void;
  onVersions: (file: FileItem) => void;
  onMoveFile: (file: FileItem, folderId: string) => void;
  onReindex: (file: FileItem) => void;
  onPreview: (file: FileItem) => void;
}

export function FileTree({
  folders,
  files,
  search,
  onUpload,
  onRenameFile,
  onDeleteFile,
  onVersions,
  onMoveFile,
  onReindex,
  onPreview,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const uploadTarget = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = search.trim().toLowerCase();
  const known = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);
  const byFolder = useMemo(() => {
    const map = new Map<string, Placed[]>();
    const put = (key: string, p: Placed) => {
      const arr = map.get(key) ?? [];
      arr.push(p);
      map.set(key, arr);
    };
    for (const f of files) {
      // Show only the latest version of each document; older versions are
      // reachable from the per-file version history.
      if (f.isLatest === false) continue;
      if (q && !f.name.toLowerCase().includes(q)) continue;
      // A folder the list doesn't know yet (just created server-side): show the
      // file at the root until the folder list catches up, never hide it.
      put(f.folderId && known.has(f.folderId) ? f.folderId : "__none__", { file: f, linked: false });
      for (const l of f.linkedFolderIds ?? []) if (l !== f.folderId) put(l, { file: f, linked: true });
    }
    return map;
  }, [files, q, known]);
  const tree = useMemo(() => buildFolderTree(folders), [folders]);

  function pickFor(folderId: string | null) {
    uploadTarget.current = folderId === INBOX_ID ? null : folderId;
    inputRef.current?.click();
  }

  const rootFiles = byFolder.get(INBOX_ID) ?? [];
  // Files without a folder are shown INSIDE a folder too (spec 007: nothing
  // lies loose) — the inbox, at the top so it is noticed.
  const inboxNode: FolderNode = {
    folder: { id: INBOX_ID, name: `Інбокс — не розкладені`, position: -1 },
    depth: 0,
    children: [],
  };

  return (
    <div style={{ overflowY: "auto", flex: 1, marginTop: 4 }}>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={UPLOAD_ACCEPT}
        onChange={(e) => {
          if (e.target.files && e.target.files.length)
            onUpload(uploadTarget.current, e.target.files);
          e.target.value = "";
        }}
      />

      {[...(rootFiles.length > 0 ? [inboxNode] : []), ...tree].map((node) => (
        <FolderBranch
          key={node.folder.id}
          node={node}
          byFolder={byFolder}
          searching={!!q}
          collapsed={collapsed}
          onToggle={(id) => setCollapsed((c) => ({ ...c, [id]: !(c[id] ?? id !== INBOX_ID) }))}
          onPick={pickFor}
          row={(p, d) => (
            <FileRow
              key={`${p.file.id}${p.linked ? "-link" : ""}`}
              file={p.file}
              linked={p.linked}
              folders={folders}
              depth={d}
              onRename={onRenameFile}
              onDelete={onDeleteFile}
              onVersions={onVersions}
              onMove={onMoveFile}
              onReindex={onReindex}
              onPreview={onPreview}
            />
          )}
        />
      ))}

      {folders.length === 0 && files.length === 0 && (
        <div style={{ color: "var(--muted)", fontSize: 13, padding: "16px 8px" }}>
          Папок ще немає.
        </div>
      )}
    </div>
  );
}

/** One folder with its files and sub-folders (spec 007 nesting). */
function FolderBranch({
  node,
  byFolder,
  searching,
  collapsed,
  onToggle,
  onPick,
  row,
}: {
  node: FolderNode;
  byFolder: Map<string, Placed[]>;
  searching: boolean;
  collapsed: Record<string, boolean>;
  onToggle: (id: string) => void;
  onPick: (folderId: string) => void;
  row: (p: Placed, depth: number) => React.ReactNode;
}) {
  const { folder, depth, children } = node;
  const items = byFolder.get(folder.id) ?? [];
  const inSubtree = subtreeIds(node).reduce((n, id) => n + (byFolder.get(id)?.length ?? 0), 0);
  if (searching && inSubtree === 0) return null;
  // Folders start collapsed so the structure is visible at a glance (a збірник
  // holds hundreds of files); the inbox starts open — it needs attention.
  const isCollapsed = collapsed[folder.id] ?? folder.id !== INBOX_ID;
  return (
    <div>
      <div className="tree-row" style={{ ...rowStyle, paddingLeft: 6 + depth * 16 }}>
        <button
          className="btn-icon"
          style={{ width: 22, height: 22 }}
          onClick={() => onToggle(folder.id)}
          aria-label="Розгорнути"
        >
          {isCollapsed ? <IconChevronRight size={15} /> : <IconChevronDown size={15} />}
        </button>
        <IconFolder size={16} />
        <span style={{ fontWeight: depth === 0 ? 600 : 500, flex: 1, minWidth: 0 }} className="ellipsis">
          {folderLabel(folder.name)}
        </span>
        {inSubtree > 0 && (
          <span
            style={{
              fontSize: 11,
              color: "var(--muted)",
              background: "var(--card)",
              borderRadius: 999,
              padding: "1px 7px",
            }}
            title={items.length !== inSubtree ? `${items.length} тут, ${inSubtree} разом із вкладеними` : undefined}
          >
            {inSubtree}
          </span>
        )}
        <button
          className="btn-icon row-action"
          onClick={() => onPick(folder.id)}
          title="Завантажити у папку"
          aria-label="Завантажити у папку"
        >
          <IconPlus size={15} />
        </button>
      </div>
      {!isCollapsed && (
        <>
          {children.map((c) => (
            <FolderBranch
              key={c.folder.id}
              node={c}
              byFolder={byFolder}
              searching={searching}
              collapsed={collapsed}
              onToggle={onToggle}
              onPick={onPick}
              row={row}
            />
          ))}
          {/* The folder's own files first, then the links to shared papers. */}
          {[...items].sort((a, b) => Number(a.linked) - Number(b.linked)).map((p) => row(p, depth))}
        </>
      )}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 6px",
  borderRadius: 7,
  minWidth: 0,
};

function FileRow({
  file,
  linked = false,
  depth = -1,
  folders,
  onRename,
  onDelete,
  onVersions,
  onMove,
  onReindex,
  onPreview,
}: {
  file: FileItem;
  /** Shown here as a link; the file itself lives in another folder. */
  linked?: boolean;
  /** Depth of the folder the row sits in (-1 = the inbox root). */
  depth?: number;
  folders: Folder[];
  onRename: (f: FileItem, name: string) => void;
  onDelete: (f: FileItem) => void;
  onVersions: (f: FileItem) => void;
  onMove: (f: FileItem, folderId: string) => void;
  onReindex: (f: FileItem) => void;
  onPreview: (f: FileItem) => void;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const status = toUiStatus(file.status);
  const suggestedFolder =
    file.folderId == null && file.suggestedFolderId
      ? folders.find((f) => f.id === file.suggestedFolderId) ?? null
      : null;
  const home = linked && file.folderId ? folderPathLabel(folders, file.folderId, folderLabel) : null;
  const title =
    home
      ? `Посилання: документ стосується кількох товарів, сам файл лежить у «${home}»`
      : file.status === "error" && file.errorReason
      ? `Помилка: ${file.errorReason}`
      : file.folderReason
        ? `Чому тут: ${file.folderReason}${file.folderConfidence ? ` (впевненість: ${CONFIDENCE_LABEL[file.folderConfidence]})` : ""}`
        : `${file.name} — натисніть для перегляду`;
  return (
    <div className="tree-row" style={{ ...rowStyle, paddingLeft: 30 + Math.max(0, depth) * 16 }} title={title}>
      <button
        onClick={() => onPreview(file)}
        title={file.name}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          textAlign: "left",
          border: "none",
          background: "transparent",
          color: "var(--text)",
          font: "inherit",
          padding: 0,
          cursor: "pointer",
        }}
      >
        <IconFile size={15} style={{ flex: "none" }} />
        <span className="ellipsis" style={{ flex: 1, minWidth: 0, fontStyle: linked ? "italic" : undefined }}>
          {file.name}
        </span>
        {linked && (
          <span style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }} aria-label="посилання">
            ↗ посилання
          </span>
        )}
      </button>
      {suggestedFolder && (
        <button
          onClick={() => onMove(file, suggestedFolder.id)}
          title={`Схоже на ${suggestedFolder.name}${file.folderReason ? ` — ${file.folderReason}` : ""}. Натисніть, щоб підтвердити.`}
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--warn)",
            background: "var(--hover)",
            border: "1px solid var(--warn)",
            borderRadius: 999,
            padding: "1px 7px",
            whiteSpace: "nowrap",
            cursor: "pointer",
          }}
        >
          ? {folderPathLabel(folders, suggestedFolder.id, folderLabel)}
        </button>
      )}
      {!linked && file.folderId && file.folderConfidence === "low" && (
        <span
          title={file.folderReason ?? "Штурман не впевнений у цій папці — перевірте"}
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--warn)",
            border: "1px solid var(--warn)",
            borderRadius: 999,
            padding: "1px 7px",
            whiteSpace: "nowrap",
          }}
        >
          перевірте
        </span>
      )}
      {file.version && file.version > 1 && (
        <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
          v{file.version}
        </span>
      )}
      <span className={`dot ${status}`} title={STATUS_LABEL[status]} />
      {file.status === "error" && (
        <button
          className="btn-icon"
          onClick={() => onReindex(file)}
          title={`Переіндексувати${file.errorReason ? ` (помилка: ${file.errorReason})` : ""}`}
          aria-label="Переіндексувати"
          style={{ color: "var(--err)" }}
        >
          <IconRefresh size={14} />
        </button>
      )}
      <div style={{ position: "relative", display: "flex" }}>
        <button
          className="btn-icon row-action"
          onClick={() => setMoveOpen((v) => !v)}
          title="Перемістити в папку"
          aria-label="Перемістити в папку"
          style={moveOpen ? { opacity: 1 } : undefined}
        >
          <IconFolder size={14} />
        </button>
        {moveOpen && (
          <>
            <div
              onClick={() => setMoveOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: 40 }}
            />
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                zIndex: 41,
                marginTop: 4,
                minWidth: 210,
                maxHeight: 260,
                overflowY: "auto",
                background: "var(--menu)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                boxShadow: "var(--shadow)",
                padding: 4,
              }}
            >
              {flattenTree(buildFolderTree(folders)).map(({ folder, depth: d }) => {
                const current = file.folderId === folder.id;
                return (
                  <button
                    key={folder.id}
                    disabled={current}
                    onClick={() => {
                      setMoveOpen(false);
                      if (!current) onMove(file, folder.id);
                    }}
                    className="ellipsis"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      textAlign: "left",
                      border: "none",
                      background: "transparent",
                      color: current ? "var(--muted)" : "var(--text)",
                      font: "inherit",
                      fontSize: 13,
                      padding: "7px 8px",
                      paddingLeft: 8 + d * 14,
                      borderRadius: 6,
                      cursor: current ? "default" : "pointer",
                    }}
                    onMouseEnter={(e) => {
                      if (!current) e.currentTarget.style.background = "var(--hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <IconFolder size={14} />
                    <span className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
                      {folderLabel(folder.name)}
                    </span>
                    {current && <IconCheck size={13} />}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
      <button
        className="btn-icon row-action"
        onClick={() => onVersions(file)}
        title="Версії"
        aria-label="Версії"
      >
        <IconHistory size={14} />
      </button>
      <button
        className="btn-icon row-action"
        onClick={() => {
          const name = window.prompt("Нова назва файла", file.name);
          if (name && name.trim() && name !== file.name) onRename(file, name.trim());
        }}
        title="Перейменувати"
        aria-label="Перейменувати"
      >
        <IconEdit size={14} />
      </button>
      <button
        className="btn-icon row-action"
        onClick={() => {
          if (window.confirm(`Видалити «${file.name}»?`)) onDelete(file);
        }}
        title="Видалити"
        aria-label="Видалити"
      >
        <IconTrash size={14} />
      </button>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  done: "Готовий",
  indexing: "Індексується",
  queued: "У черзі",
  error: "Помилка",
};

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "висока",
  medium: "середня",
  low: "низька",
};
