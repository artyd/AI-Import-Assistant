"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { openEventsChannel } from "@/lib/sse";
import type {
  ChecklistItem,
  ConversationMeta,
  FileItem,
  FileStatusEvent,
  Folder,
  Message,
  Workspace,
} from "@/lib/types";
import { Chat } from "@/components/Chat";
import { AgentLog, type LogEntry } from "@/components/AgentLog";
import { ShipmentPanel } from "@/components/ShipmentPanel";
import { VersionsModal } from "@/components/VersionsModal";
import { FilePreviewModal } from "@/components/FilePreviewModal";
import { SidebarNav } from "@/components/SidebarNav";
import { TopBar, type CompletenessStep } from "@/components/TopBar";
import { RightPanel, type RightTab } from "@/components/RightPanel";
import { FilesTab } from "@/components/FilesTab";
import { CommandPalette, type PaletteAction } from "@/components/CommandPalette";
import { IconSpinner } from "@/components/icons";
import {
  LnExport,
  LnFolder,
  LnFolderPlus,
  LnList,
  LnLock,
  LnMoon,
  LnPencil,
  LnUpload,
} from "@/components/LineIcons";

// Run an async mapper over items with bounded concurrency, preserving order.
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const REQ_LABEL: Record<string, string> = {
  contract: "Контракт",
  invoice: "Інвойс",
  proforma: "Проформа",
  packing_list: "Пакувальний лист",
  cmr: "CMR",
  certificate_of_origin: "Сертифікат походження",
  quality_certificate: "Сертифікат якості",
  customs_declaration: "Митна декларація",
  payment: "Оплата",
  specification: "Специфікація",
};

export default function WorkspacePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { user, loading: authLoading, logout } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [chatSeq, setChatSeq] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [checklist, setChecklist] = useState<ChecklistItem[] | null>(null);

  // Shell UI state.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const [rightTab, setRightTab] = useState<RightTab>("files");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sound, setSound] = useState(false);

  const [versionsFile, setVersionsFile] = useState<FileItem | null>(null);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);

  const paletteUploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [user, authLoading, router]);

  useEffect(() => {
    try {
      setSound(localStorage.getItem("shturman-sound") === "on");
    } catch {
      /* ignore */
    }
  }, []);

  // Load workspace, folders, files, workspaces list, and latest conversation.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [wsRes, filesRes, listRes] = await Promise.all([
          api<{ workspace: Workspace; folders: Folder[] }>(`/api/workspaces/${id}`),
          api<{ files: FileItem[] }>(`/api/workspaces/${id}/files`),
          api<{ workspaces: Workspace[] }>(`/api/workspaces`),
        ]);
        if (cancelled) return;
        setWorkspace(wsRes.workspace);
        setFolders(wsRes.folders);
        setFiles(filesRes.files);
        setWorkspaces(listRes.workspaces);

        try {
          const { conversations } = await api<{ conversations: ConversationMeta[] }>(
            `/api/workspaces/${id}/conversations`
          );
          if (!cancelled) setConversations(conversations);
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

  // Completeness for the top-bar step dots + right-panel badge.
  const refreshChecklist = useCallback(() => {
    api<{ items: ChecklistItem[] }>(`/api/workspaces/${id}/checklist`)
      .then((r) => setChecklist(r.items))
      .catch(() => setChecklist(null));
  }, [id]);

  useEffect(() => {
    if (user && workspace) refreshChecklist();
  }, [user, workspace, refreshChecklist]);

  // Live file-status channel.
  useEffect(() => {
    if (!user || !workspace) return;
    const es = openEventsChannel(id, (raw) => {
      const ev = raw as FileStatusEvent;
      setFiles((prev) => {
        if (ev.status === "deleted") return prev.filter((f) => f.id !== ev.fileId);
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
          folderId: ev.folderId !== undefined ? ev.folderId : next[idx]!.folderId,
        };
        return next;
      });
    });
    return () => es.close();
  }, [id, user, workspace]);

  const onLog = useCallback((entry: LogEntry) => setLog((l) => [...l, entry]), []);
  const onPatch = useCallback(
    (partial: Partial<Workspace>) => setWorkspace((w) => (w ? { ...w, ...partial } : w)),
    []
  );

  const refreshFiles = useCallback(async () => {
    const r = await api<{ files: FileItem[] }>(`/api/workspaces/${id}/files`);
    setFiles(r.files);
  }, [id]);

  const upload = useCallback(
    async (
      folderId: string | null,
      fileList: FileList | File[],
      replacesFileId?: string
    ): Promise<FileItem[]> => {
      const form = new FormData();
      for (const f of Array.from(fileList)) form.append("files", f, f.name || "file");
      const sp = new URLSearchParams();
      if (folderId) sp.set("folderId", folderId);
      if (replacesFileId) sp.set("replacesFileId", replacesFileId);
      const qs = sp.toString() ? `?${sp.toString()}` : "";
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
          alert("Відхилено:\n" + res.rejected.map((r) => `• ${r.name} — ${r.reason}`).join("\n"));
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
      await refreshFiles();
    },
    [upload, refreshFiles, versionsFile]
  );

  const renameFile = useCallback(
    async (file: FileItem, name: string) => {
      setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, name } : f)));
      try {
        await api(`/api/workspaces/${id}/files/${file.id}`, { method: "PATCH", body: { name } });
      } catch {
        setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, name: file.name } : f)));
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

  const moveFile = useCallback(
    async (fileId: string, folderId: string) => {
      const prev = files;
      setFiles((p) => p.map((f) => (f.id === fileId ? { ...f, folderId } : f)));
      try {
        await api(`/api/workspaces/${id}/files/${fileId}`, { method: "PATCH", body: { folderId } });
      } catch {
        setFiles(prev);
        throw new Error("move_failed");
      }
    },
    [id, files]
  );

  const classifyFile = useCallback(
    async (fileId: string): Promise<string | null> => {
      const { folderName } = await api<{ fileId: string; folderName: string | null }>(
        `/api/workspaces/${id}/files/${fileId}/classify`,
        { method: "POST" }
      );
      if (folderName) {
        const target = folders.find((f) => f.name === folderName);
        if (target)
          setFiles((p) => p.map((f) => (f.id === fileId ? { ...f, folderId: target.id } : f)));
      }
      return folderName;
    },
    [id, folders]
  );

  // Upload + auto-distribute: when 2+ files land in the root (inbox), classify
  // each into its skeleton folder automatically (single files are left in the
  // root for the user to place). Folder-targeted uploads are never reclassified.
  const uploadSmart = useCallback(
    async (folderId: string | null, fileList: FileList | File[]): Promise<FileItem[]> => {
      const created = await upload(folderId, fileList);
      if (folderId == null && created.length >= 2) {
        await mapLimit(created, 4, (f) => classifyFile(f.id).catch(() => null));
      }
      return created;
    },
    [upload, classifyFile]
  );

  const uploadAndClassify = useCallback(
    async (
      fileList: FileList | File[]
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
    const name = window.prompt("Назва теки");
    if (!name || !name.trim()) return;
    try {
      const { folder } = await api<{ folder: Folder }>(`/api/workspaces/${id}/folders`, {
        body: { name: name.trim() },
      });
      setFolders((f) => [...f, folder]);
    } catch {
      alert("Не вдалося створити теку.");
    }
  }, [id]);

  const sortInbox = useCallback(async () => {
    try {
      const res = await api<{
        moved: { fileId: string; name: string; to: string }[];
        unclassified: { fileId: string; name: string }[];
      }>(`/api/workspaces/${id}/sort-inbox`, { method: "POST" });
      await refreshFiles();
      const left = res.unclassified.length;
      alert(`Розкладено: ${res.moved.length}.` + (left ? `\nНе вдалося визначити: ${left}.` : ""));
    } catch {
      alert("Не вдалося розкласти інбокс.");
    }
  }, [id, refreshFiles]);

  const refreshConversations = useCallback(async () => {
    try {
      const { conversations } = await api<{ conversations: ConversationMeta[] }>(
        `/api/workspaces/${id}/conversations`
      );
      setConversations(conversations);
    } catch {
      /* ignore */
    }
  }, [id]);

  const loadConversation = useCallback(
    async (convId: string) => {
      if (convId === conversationId) return;
      try {
        const conv = await api<{ conversationId: string; messages: Message[] }>(
          `/api/workspaces/${id}/conversations/${convId}`
        );
        setConversationId(conv.conversationId);
        setInitialMessages(conv.messages);
      } catch {
        alert("Не вдалося завантажити розмову.");
      }
    },
    [id, conversationId]
  );

  const newChat = useCallback(() => {
    setConversationId(undefined);
    setInitialMessages([]);
    setChatSeq((n) => n + 1);
  }, []);

  const onConversationStarted = useCallback(
    (cid: string) => {
      setConversationId(cid);
      void refreshConversations();
    },
    [refreshConversations]
  );

  const reindexFile = useCallback(
    async (file: FileItem) => {
      setFiles((p) =>
        p.map((f) => (f.id === file.id ? { ...f, status: "queued", errorReason: null } : f))
      );
      try {
        await api(`/api/workspaces/${id}/files/${file.id}/reindex`, { method: "POST" });
      } catch {
        alert("Не вдалося запустити переіндексацію.");
        await refreshFiles();
      }
    },
    [id, refreshFiles]
  );

  // Shell actions.
  const selectShipment = useCallback((wid: string) => router.push(`/workspaces/${wid}`), [router]);

  const newShipment = useCallback(async () => {
    const number = window.prompt("Номер постачання (необов'язково)") ?? "";
    try {
      const { workspace } = await api<{ workspace: Workspace }>(`/api/workspaces`, {
        body: { number: number.trim() || undefined, status: "active" },
      });
      router.push(`/workspaces/${workspace.id}`);
    } catch {
      alert("Не вдалося створити постачання.");
    }
  }, [router]);

  const deleteShipment = useCallback(async () => {
    if (!workspace) return;
    const ok = window.confirm(
      `Видалити постачання №${workspace.number ?? "—"}?\n\n` +
        "Буде видалено всі файли, теки та чати. Дію не можна скасувати."
    );
    if (!ok) return;
    try {
      await api(`/api/workspaces/${id}`, { method: "DELETE" });
      const other = workspaces.find((w) => w.id !== id);
      router.push(other ? `/workspaces/${other.id}` : "/workspaces");
    } catch {
      alert("Не вдалося видалити постачання.");
    }
  }, [id, workspace, workspaces, router]);

  const saveSupplier = useCallback(
    async (supplier: string) => {
      onPatch({ supplier: supplier || null });
      try {
        // Schema accepts a string (not null) — send "" to clear.
        await api(`/api/workspaces/${id}`, { method: "PATCH", body: { supplier } });
      } catch {
        /* keep optimistic value; a reload will reconcile */
      }
    },
    [id, onPatch]
  );

  const toggleSound = useCallback(() => {
    setSound((s) => {
      const next = !s;
      try {
        localStorage.setItem("shturman-sound", next ? "on" : "off");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const lock = useCallback(() => logout(), [logout]);

  const openRightTab = useCallback((t: RightTab) => {
    setRightTab(t);
    setRightOpen(true);
  }, []);

  // ⌘K / Ctrl+K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const steps: CompletenessStep[] = useMemo(
    () =>
      (checklist ?? []).slice(0, 8).map((ci) => ({
        label: REQ_LABEL[ci.requirement_key] ?? ci.requirement_key.replace(/_/g, " "),
        ok: ci.status !== "missing",
      })),
    [checklist]
  );
  const missingCount = (checklist ?? []).filter((c) => c.status === "missing").length;
  const hasInbox = files.some((f) => f.folderId == null && f.isLatest !== false);

  const paletteActions: PaletteAction[] = useMemo(() => {
    const a: PaletteAction[] = [
      { id: "new-chat", label: "Новий чат", hint: "чат", icon: <LnPencil size={17} />, run: newChat },
      { id: "new-shipment", label: "Нове постачання", icon: <LnFolderPlus size={17} />, run: newShipment },
      {
        id: "upload",
        label: "Завантажити файл",
        icon: <LnUpload size={17} />,
        run: () => paletteUploadRef.current?.click(),
      },
      { id: "files", label: "Файли", icon: <LnFolder size={17} />, run: () => openRightTab("files") },
      { id: "journal", label: "Журнал агента", icon: <LnList size={17} />, run: () => openRightTab("journal") },
      {
        id: "complete",
        label: "Комплектність та дії",
        hint: missingCount ? `бракує ${missingCount}` : "",
        icon: <LnExport size={17} />,
        run: () => openRightTab("complete"),
      },
    ];
    if (hasInbox)
      a.push({ id: "sort", label: "Розкласти інбокс", icon: <LnFolder size={17} />, run: sortInbox });
    a.push({ id: "theme", label: "Перемкнути тему", icon: <LnMoon size={17} />, run: toggleTheme });
    a.push({ id: "lock", label: "Заблокувати (вийти)", icon: <LnLock size={17} />, run: lock });
    return a;
  }, [newChat, newShipment, openRightTab, missingCount, hasInbox, sortInbox, toggleTheme, lock]);

  if (authLoading || (loading && !workspace)) {
    return (
      <div style={{ height: "100vh", display: "grid", placeItems: "center" }}>
        <IconSpinner size={26} />
      </div>
    );
  }

  if (notFound) {
    return (
      <div style={{ height: "100vh", display: "grid", placeItems: "center", color: "var(--muted)" }}>
        <div style={{ textAlign: "center" }}>
          <p>Постачання не знайдено.</p>
          <button className="btn" onClick={() => router.push("/workspaces")}>
            До списку постачань
          </button>
        </div>
      </div>
    );
  }

  if (!workspace) return null;

  return (
    <div style={{ height: "100vh", display: "flex", overflow: "hidden", background: "var(--chat)" }}>
      <input
        ref={paletteUploadRef}
        type="file"
        multiple
        hidden
        accept=".pdf,.docx,.xlsx,.csv,.png,.jpg,.jpeg"
        onChange={(e) => {
          if (e.target.files && e.target.files.length) uploadSmart(null, e.target.files);
          e.target.value = "";
        }}
      />

      <SidebarNav
        workspaces={workspaces}
        current={workspace}
        conversations={conversations}
        currentConversationId={conversationId}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        onNewChat={newChat}
        onNewShipment={newShipment}
        onOpenSearch={() => setPaletteOpen(true)}
        onSelectShipment={selectShipment}
        onDeleteShipment={deleteShipment}
        onSelectConversation={loadConversation}
      />

      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "var(--chat)" }}>
        <TopBar
          workspace={workspace}
          steps={steps}
          rightOpen={rightOpen}
          onToggleRight={() => setRightOpen((v) => !v)}
          onTogglePalette={() => setPaletteOpen((v) => !v)}
          sound={sound}
          onToggleSound={toggleSound}
          onLock={lock}
          theme={theme}
          onToggleTheme={toggleTheme}
          onSaveSupplier={saveSupplier}
        />
        <div style={{ flex: 1, minHeight: 0 }}>
          <Chat
            key={`${conversationId ?? "new"}-${chatSeq}`}
            workspaceId={id}
            conversationId={conversationId}
            initialMessages={initialMessages}
            onConversationStarted={onConversationStarted}
            onLog={onLog}
            folders={folders}
            onUploadAndClassify={uploadAndClassify}
            onMoveFile={moveFile}
          />
        </div>
      </main>

      {rightOpen && (
        <RightPanel
          tab={rightTab}
          onTab={setRightTab}
          onClose={() => setRightOpen(false)}
          badges={{ files: files.filter((f) => f.isLatest !== false).length, complete: missingCount }}
          files={
            <FilesTab
              workspaceNumber={workspace.number}
              folders={folders}
              files={files}
              onUpload={uploadSmart}
              onCreateFolder={createFolder}
              onRenameFile={renameFile}
              onDeleteFile={deleteFile}
              onVersions={setVersionsFile}
              onMoveFile={(file, folderId) => {
                void moveFile(file.id, folderId).catch(() => alert("Не вдалося перемістити файл."));
              }}
              onReindex={reindexFile}
              onPreview={setPreviewFile}
            />
          }
          journal={<AgentLog entries={log} embedded />}
          complete={<ShipmentPanel workspaceId={id} workspace={workspace} onPatch={onPatch} />}
        />
      )}

      {paletteOpen && (
        <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />
      )}

      {versionsFile && (
        <VersionsModal
          workspaceId={id}
          fileId={versionsFile.id}
          onClose={() => setVersionsFile(null)}
          onUploadVersion={onUploadVersion}
        />
      )}
      {previewFile && (
        <FilePreviewModal workspaceId={id} file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
    </div>
  );
}
