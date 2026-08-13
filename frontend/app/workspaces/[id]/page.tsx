"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { openEventsChannel } from "@/lib/sse";
import type {
  FileItem,
  FileStatusEvent,
  Folder,
  Message,
  Workspace,
} from "@/lib/types";
import { Header } from "@/components/Header";
import { FileTree } from "@/components/FileTree";
import { WorkspaceSelector } from "@/components/WorkspaceSelector";
import { Chat } from "@/components/Chat";
import { AgentLog, type LogEntry } from "@/components/AgentLog";
import { ShipmentPanel } from "@/components/ShipmentPanel";
import { VersionsModal } from "@/components/VersionsModal";
import {
  IconSearch,
  IconFolderPlus,
  IconUpload,
  IconSpinner,
} from "@/components/icons";

// Run an async mapper over items with bounded concurrency, preserving order.
// Keeps the post-upload classify calls from firing as one big burst (which can
// trip provider rate limits and surface as spurious "couldn't classify").
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

export default function WorkspacePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [rightTab, setRightTab] = useState<"shipment" | "log">("shipment");
  const [versionsFile, setVersionsFile] = useState<FileItem | null>(null);

  const rootUploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [user, authLoading, router]);

  // Load workspace, folders, files, workspaces list, and latest conversation.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [wsRes, filesRes, listRes] = await Promise.all([
          api<{ workspace: Workspace; folders: Folder[] }>(
            `/api/workspaces/${id}`
          ),
          api<{ files: FileItem[] }>(`/api/workspaces/${id}/files`),
          api<{ workspaces: Workspace[] }>(`/api/workspaces`),
        ]);
        if (cancelled) return;
        setWorkspace(wsRes.workspace);
        setFolders(wsRes.folders);
        setFiles(filesRes.files);
        setWorkspaces(listRes.workspaces);

        // Restore the most recent conversation, if any.
        try {
          const { conversations } = await api<{
            conversations: { id: string; updated_at: string }[];
          }>(`/api/workspaces/${id}/conversations`);
          if (!cancelled && conversations.length > 0) {
            const latest = [...conversations].sort((a, b) =>
              b.updated_at.localeCompare(a.updated_at)
            )[0]!;
            const conv = await api<{ conversationId: string; messages: Message[] }>(
              `/api/workspaces/${id}/conversations/${latest.id}`
            );
            if (!cancelled) {
              setConversationId(conv.conversationId);
              setInitialMessages(conv.messages);
            }
          }
        } catch {
          /* no conversations yet — fine */
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, user]);

  // Live file-status channel.
  useEffect(() => {
    if (!user || !workspace) return;
    const es = openEventsChannel(id, (raw) => {
      const ev = raw as FileStatusEvent;
      setFiles((prev) => {
        if (ev.status === "deleted")
          return prev.filter((f) => f.id !== ev.fileId);
        const idx = prev.findIndex((f) => f.id === ev.fileId);
        if (idx === -1) {
          if (!ev.name) return prev;
          return [
            ...prev,
            {
              id: ev.fileId,
              folderId: null,
              name: ev.name,
              type: "",
              status: ev.status,
              errorReason: ev.errorReason ?? null,
            },
          ];
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx]!,
          status: ev.status,
          errorReason: ev.errorReason ?? next[idx]!.errorReason,
        };
        return next;
      });
    });
    return () => es.close();
  }, [id, user, workspace]);

  const onLog = useCallback((entry: LogEntry) => {
    setLog((l) => [...l, entry]);
  }, []);

  const onPatch = useCallback((partial: Partial<Workspace>) => {
    setWorkspace((w) => (w ? { ...w, ...partial } : w));
  }, []);

  const refreshFiles = useCallback(async () => {
    const r = await api<{ files: FileItem[] }>(`/api/workspaces/${id}/files`);
    setFiles(r.files);
  }, [id]);

  const upload = useCallback(
    async (
      folderId: string | null,
      fileList: FileList,
      replacesFileId?: string
    ): Promise<FileItem[]> => {
      const form = new FormData();
      for (const f of Array.from(fileList)) form.append("files", f);
      const params = new URLSearchParams();
      if (folderId) params.set("folderId", folderId);
      if (replacesFileId) params.set("replacesFileId", replacesFileId);
      const qs = params.toString() ? `?${params.toString()}` : "";
      try {
        const res = await api<{
          files: FileItem[];
          rejected?: { name: string; reason: string }[];
        }>(`/api/workspaces/${id}/files${qs}`, { form });
        setFiles((prev) => {
          const known = new Set(prev.map((p) => p.id));
          return [...prev, ...res.files.filter((f) => !known.has(f.id))];
        });
        if (res.rejected && res.rejected.length) {
          alert(
            "Відхилено:\n" +
              res.rejected.map((r) => `• ${r.name} — ${r.reason}`).join("\n")
          );
        }
        return res.files;
      } catch (err) {
        if (err instanceof ApiError && err.code === "no_valid_files")
          alert("Жоден файл не підійшов (дозволені: pdf, docx, xlsx, csv, png, jpg).");
        else alert("Не вдалося завантажити файли.");
        return [];
      }
    },
    [id]
  );

  const onUploadVersion = useCallback(
    async (replacesFileId: string, fileList: FileList) => {
      await upload(versionsFile?.folderId ?? null, fileList, replacesFileId);
      await refreshFiles(); // pick up the previous version's is_latest = false
    },
    [upload, refreshFiles, versionsFile]
  );

  const renameFile = useCallback(
    async (file: FileItem, name: string) => {
      setFiles((prev) =>
        prev.map((f) => (f.id === file.id ? { ...f, name } : f))
      );
      try {
        await api(`/api/workspaces/${id}/files/${file.id}`, {
          method: "PATCH",
          body: { name },
        });
      } catch {
        setFiles((prev) =>
          prev.map((f) => (f.id === file.id ? { ...f, name: file.name } : f))
        );
      }
    },
    [id]
  );

  const deleteFile = useCallback(
    async (file: FileItem) => {
      const prev = files;
      setFiles((p) => p.filter((f) => f.id !== file.id));
      try {
        await api(`/api/workspaces/${id}/files/${file.id}`, { method: "DELETE" });
      } catch {
        setFiles(prev);
      }
    },
    [id, files]
  );

  // Move a file into a folder — reuses the same PATCH endpoint as rename.
  const moveFile = useCallback(
    async (fileId: string, folderId: string) => {
      const prev = files;
      setFiles((p) =>
        p.map((f) => (f.id === fileId ? { ...f, folderId } : f))
      );
      try {
        await api(`/api/workspaces/${id}/files/${fileId}`, {
          method: "PATCH",
          body: { folderId },
        });
      } catch {
        setFiles(prev);
        throw new Error("move_failed");
      }
    },
    [id, files]
  );

  // Auto-classify one just-uploaded file; on a match, reflect the move locally.
  const classifyFile = useCallback(
    async (fileId: string): Promise<string | null> => {
      const { folderName } = await api<{
        fileId: string;
        folderName: string | null;
      }>(`/api/workspaces/${id}/files/${fileId}/classify`, { method: "POST" });
      if (folderName) {
        const target = folders.find((f) => f.name === folderName);
        if (target)
          setFiles((p) =>
            p.map((f) => (f.id === fileId ? { ...f, folderId: target.id } : f))
          );
      }
      return folderName;
    },
    [id, folders]
  );

  // Paperclip flow: upload into the inbox, then classify each created file.
  const uploadAndClassify = useCallback(
    async (
      fileList: FileList
    ): Promise<{ fileId: string; name: string; folderName: string | null }[]> => {
      const created = await upload(null, fileList);
      return mapLimit(created, 4, async (f) => {
        try {
          const folderName = await classifyFile(f.id);
          return { fileId: f.id, name: f.name, folderName };
        } catch {
          return { fileId: f.id, name: f.name, folderName: null };
        }
      });
    },
    [upload, classifyFile]
  );

  const createFolder = useCallback(async () => {
    const name = window.prompt("Назва папки");
    if (!name || !name.trim()) return;
    try {
      const { folder } = await api<{ folder: Folder }>(
        `/api/workspaces/${id}/folders`,
        { body: { name: name.trim() } }
      );
      setFolders((f) => [...f, folder]);
    } catch {
      alert("Не вдалося створити папку.");
    }
  }, [id]);

  if (authLoading || (loading && !workspace)) {
    return (
      <div style={{ height: "100vh", display: "grid", placeItems: "center" }}>
        <IconSpinner size={26} />
      </div>
    );
  }

  if (notFound) {
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        <Header />
        <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--muted)" }}>
          <div style={{ textAlign: "center" }}>
            <p>Поставку не знайдено.</p>
            <button className="btn" onClick={() => router.push("/workspaces")}>
              До списку поставок
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <Header workspace={workspace} />

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* LEFT — files */}
        <aside
          style={{
            width: 300,
            flex: "none",
            borderRight: "1px solid var(--border)",
            background: "var(--panel)",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            padding: 14,
            gap: 10,
          }}
        >
          {workspace && (
            <WorkspaceSelector workspaces={workspaces} current={workspace} />
          )}

          <div style={{ position: "relative" }}>
            <span
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--muted)",
                pointerEvents: "none",
              }}
            >
              <IconSearch size={16} />
            </span>
            <input
              className="input"
              placeholder="Пошук по файлах"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ paddingLeft: 34 }}
            />
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={createFolder} style={{ flex: 1 }}>
              <IconFolderPlus size={16} /> Папка
            </button>
            <button
              className="btn btn-primary"
              onClick={() => rootUploadRef.current?.click()}
              style={{ flex: 1 }}
            >
              <IconUpload size={16} /> Завантажити
            </button>
            <input
              ref={rootUploadRef}
              type="file"
              multiple
              hidden
              accept=".pdf,.docx,.xlsx,.csv,.png,.jpg,.jpeg"
              onChange={(e) => {
                if (e.target.files && e.target.files.length)
                  upload(null, e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          <Legend />

          <FileTree
            folders={folders}
            files={files}
            search={search}
            onUpload={upload}
            onRenameFile={renameFile}
            onDeleteFile={deleteFile}
            onVersions={setVersionsFile}
            onMoveFile={(file, folderId) => {
              void moveFile(file.id, folderId).catch(() => {
                alert("Не вдалося перемістити файл.");
              });
            }}
          />
        </aside>

        {/* CENTER — chat */}
        <main style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          {workspace && (
            <Chat
              key={conversationId ?? "new"}
              workspaceId={id}
              conversationId={conversationId}
              initialMessages={initialMessages}
              onConversationStarted={setConversationId}
              onLog={onLog}
              folders={folders}
              onUploadAndClassify={uploadAndClassify}
              onMoveFile={moveFile}
            />
          )}
        </main>

        {/* RIGHT — shipment panel / agent log (tabbed) */}
        <aside
          style={{
            width: 340,
            flex: "none",
            borderLeft: "1px solid var(--border)",
            background: "var(--panel)",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ display: "flex", borderBottom: "1px solid var(--border)", flex: "none" }}>
            {(
              [
                ["shipment", "Постачання"],
                ["log", "Журнал"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setRightTab(key)}
                style={{
                  flex: 1,
                  height: 42,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  font: "inherit",
                  fontWeight: 600,
                  color: rightTab === key ? "var(--text)" : "var(--muted)",
                  borderBottom: rightTab === key ? "2px solid var(--accent)" : "2px solid transparent",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {rightTab === "shipment" && workspace ? (
              <ShipmentPanel workspaceId={id} workspace={workspace} onPatch={onPatch} />
            ) : (
              <AgentLog entries={log} />
            )}
          </div>
        </aside>
      </div>

      {versionsFile && (
        <VersionsModal
          workspaceId={id}
          fileId={versionsFile.id}
          onClose={() => setVersionsFile(null)}
          onUploadVersion={onUploadVersion}
        />
      )}
    </div>
  );
}

function Legend() {
  const items: { cls: string; label: string }[] = [
    { cls: "done", label: "Готовий" },
    { cls: "indexing", label: "Індексується" },
    { cls: "queued", label: "У черзі" },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        fontSize: 11,
        color: "var(--muted)",
        padding: "0 2px",
      }}
    >
      {items.map((i) => (
        <span key={i.cls} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span className={`dot ${i.cls}`} /> {i.label}
        </span>
      ))}
    </div>
  );
}
