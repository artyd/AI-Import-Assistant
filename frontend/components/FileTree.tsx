"use client";

import { useMemo, useRef, useState } from "react";
import type { FileItem, Folder } from "@/lib/types";
import { toUiStatus } from "@/lib/types";
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconPlus,
  IconEdit,
  IconTrash,
} from "./icons";

interface Props {
  folders: Folder[];
  files: FileItem[];
  search: string;
  onUpload: (folderId: string | null, files: FileList) => void;
  onRenameFile: (file: FileItem, name: string) => void;
  onDeleteFile: (file: FileItem) => void;
}

export function FileTree({
  folders,
  files,
  search,
  onUpload,
  onRenameFile,
  onDeleteFile,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const uploadTarget = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = search.trim().toLowerCase();
  const byFolder = useMemo(() => {
    const map = new Map<string, FileItem[]>();
    for (const f of files) {
      if (q && !f.name.toLowerCase().includes(q)) continue;
      const key = f.folderId ?? "__none__";
      const arr = map.get(key) ?? [];
      arr.push(f);
      map.set(key, arr);
    }
    return map;
  }, [files, q]);

  function pickFor(folderId: string | null) {
    uploadTarget.current = folderId;
    inputRef.current?.click();
  }

  const rootFiles = byFolder.get("__none__") ?? [];

  return (
    <div style={{ overflowY: "auto", flex: 1, marginTop: 4 }}>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept=".pdf,.docx,.xlsx,.csv,.png,.jpg,.jpeg"
        onChange={(e) => {
          if (e.target.files && e.target.files.length)
            onUpload(uploadTarget.current, e.target.files);
          e.target.value = "";
        }}
      />

      {folders.map((folder) => {
        const items = byFolder.get(folder.id) ?? [];
        if (q && items.length === 0) return null;
        const isCollapsed = collapsed[folder.id];
        return (
          <div key={folder.id}>
            <div className="tree-row" style={rowStyle}>
              <button
                className="btn-icon"
                style={{ width: 22, height: 22 }}
                onClick={() =>
                  setCollapsed((c) => ({ ...c, [folder.id]: !c[folder.id] }))
                }
                aria-label="Розгорнути"
              >
                {isCollapsed ? (
                  <IconChevronRight size={15} />
                ) : (
                  <IconChevronDown size={15} />
                )}
              </button>
              <IconFolder size={16} />
              <span style={{ fontWeight: 600, flex: 1, minWidth: 0 }} className="ellipsis">
                {folder.name}
              </span>
              {items.length > 0 && (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--muted)",
                    background: "var(--card)",
                    borderRadius: 999,
                    padding: "1px 7px",
                  }}
                >
                  {items.length}
                </span>
              )}
              <button
                className="btn-icon row-action"
                onClick={() => pickFor(folder.id)}
                title="Завантажити у папку"
                aria-label="Завантажити у папку"
              >
                <IconPlus size={15} />
              </button>
            </div>

            {!isCollapsed &&
              items.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  onRename={onRenameFile}
                  onDelete={onDeleteFile}
                />
              ))}
          </div>
        );
      })}

      {rootFiles.map((file) => (
        <FileRow
          key={file.id}
          file={file}
          onRename={onRenameFile}
          onDelete={onDeleteFile}
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
  onRename,
  onDelete,
}: {
  file: FileItem;
  onRename: (f: FileItem, name: string) => void;
  onDelete: (f: FileItem) => void;
}) {
  const status = toUiStatus(file.status);
  const title =
    file.status === "error" && file.errorReason
      ? `Помилка: ${file.errorReason}`
      : file.name;
  return (
    <div className="tree-row" style={{ ...rowStyle, paddingLeft: 30 }} title={title}>
      <IconFile size={15} />
      <span className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
        {file.name}
      </span>
      <span className={`dot ${status}`} title={STATUS_LABEL[status]} />
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
