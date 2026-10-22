"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { NoticeBanner, type NoticeTone } from "@/components/ui/Notice";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { useShipmentFiles } from "@/lib/files/useShipmentFiles";
import type {
  AnalysisResult,
  Collection,
  ConversationMeta,
  FileItem,
  Folder,
  Message,
  Workspace,
} from "@/lib/types";
import { Chat, type EntitySelector } from "@/components/chat/Chat";
import type { SurveyAnswers, SurveyIntakeField, SurveyStatus } from "@/lib/surveyQuestions";
import { AnalyzePanel } from "@/components/analysis/AnalyzePanel";
import { ArchiveList } from "@/components/analysis/ArchiveModal";
import { AiSettingsModal } from "@/components/analysis/AiSettingsModal";
import { useAppStore } from "@/lib/store";
import { fetchConversation, fetchConversations, newestConversation, resolveChatEndpoints } from "@/lib/chatContext";
import { analyzeBody, fetchLatestAnalysis, runAnalysis } from "@/lib/analysis/run";
import { AgentLog, type LogEntry } from "@/components/chat/AgentLog";
import { ShipmentPanel } from "@/components/shipment/ShipmentPanel";
import { VersionsModal } from "@/components/files/VersionsModal";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { SidebarNav } from "@/components/layout/SidebarNav";
import { TopBar, type CompletenessStep } from "@/components/layout/TopBar";
import { RightPanel, type RightTab } from "@/components/shipment/RightPanel";
import { FilesTab } from "@/components/files/FilesTab";
import { LotsTab } from "@/components/fcl/LotsTab";
import { FclCompleteness } from "@/components/fcl/FclCompleteness";
import { useFclOverview } from "@/lib/fcl/useFcl";
import { NewsView } from "@/components/news/NewsView";
import { MapView } from "@/components/hub/MapView";
import { CalendarView } from "@/components/calendar/CalendarView";
import { CommandPalette, type PaletteAction } from "@/components/layout/CommandPalette";
import { IconSpinner } from "@/components/ui/icons";
import { useShipmentData } from "@/lib/shipment/shipmentData";
import {
  LnExport,
  LnFolder,
  LnFolderPlus,
  LnList,
  LnLock,
  LnMoon,
  LnPencil,
  LnSettings,
  LnUpload,
} from "@/components/ui/LineIcons";

// Starter prompts for a NEW consolidated (Збірний) chat — analysis-oriented.
const CONSOLIDATED_STARTERS: { text: string; icon: React.ReactNode }[] = [
  { text: "Проаналізуй збірник за посиланням на Google Sheets", icon: <LnList size={15} /> },
  { text: "Порахуй мито та ПДВ по позиціях", icon: <LnFolder size={15} /> },
  { text: "Які документи потрібні для транзиту через ЄС?", icon: <LnUpload size={15} /> },
];

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
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [chatSeq, setChatSeq] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // Completeness / risks / parties of the open shipment (shared with the panel).
  const checklist = useShipmentData((s) => s.checklist);
  const loadShipmentData = useShipmentData((s) => s.load);
  const refreshChecklist = useShipmentData((s) => s.refreshChecklist);
  const invalidateShipment = useShipmentData((s) => s.invalidate);

  // In-app notice banner (replaces blocking alert()).
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone } | null>(null);
  const notify = useCallback(
    (text: string, tone: NoticeTone = "error") => setNotice({ text, tone }),
    []
  );
  const closeNotice = useCallback(() => setNotice(null), []);

  // The shipment's files: list, live status, uploads and file operations.
  const {
    files,
    setFiles,
    uploadProgress,
    docsStatus,
    refreshFiles,
    upload,
    renameFile,
    deleteFile,
    moveFile,
    uploadSmart,
    uploadAndClassify,
    sortInbox,
    reindexFile,
  } = useShipmentFiles(id, { live: !!user && workspace != null, folders, notify });
  // Collection (Збірник) folders for the right panel when consolidated is active.
  const [colFolders, setColFolders] = useState<Folder[]>([]);

  // Consolidated-cargo analysis result (latest) + archive modal.
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [showIntake, setShowIntake] = useState(false);
  // Progress for a chat-triggered analysis (paperclip / pasted link) run directly
  // through the analyze endpoint so the EXACT per-product blocks land in the thread.
  const [analyzeProgress, setAnalyzeProgress] = useState<{ pct: number; step: string } | null>(null);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);

  // Shell UI state.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const [rightTab, setRightTab] = useState<RightTab>("files");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sound, setSound] = useState(false);

  // App-wide store: which chat kind + top-level view + collections are active.
  const chatKind = useAppStore((s) => s.chatKind);
  const setChatKind = useAppStore((s) => s.setChatKind);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const collections = useAppStore((s) => s.collections);
  const setCollections = useAppStore((s) => s.setCollections);
  const activeCollectionId = useAppStore((s) => s.activeCollectionId);
  const setActiveCollectionId = useAppStore((s) => s.setActiveCollectionId);
  const addCollection = useAppStore((s) => s.addCollection);
  const removeCollection = useAppStore((s) => s.removeCollection);

  // A Збірник is an FCL workspace (spec 006): its files go through the same
  // pipeline as a shipment's (read, extracted, filed into lots), live via SSE.
  const fclId = chatKind === "consolidated" ? activeCollectionId : null;
  const fclFiles = useShipmentFiles(activeCollectionId ?? id, {
    live: !!user && !!fclId,
    folders: colFolders,
    notify,
  });
  const fcl = useFclOverview(fclId);
  const [fclScope, setFclScope] = useState<string>("fcl");

  // Chat endpoints for the active (kind, entity). null = consolidated without a
  // selected collection (the UI then prompts to create/select one).
  const endpoints = useMemo(
    () => resolveChatEndpoints(chatKind, id, activeCollectionId),
    [chatKind, id, activeCollectionId]
  );

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

  // Responsive: on a narrow viewport the sidebar + the 344px right panel would
  // squeeze the chat column to zero width. Start with the right panel collapsed
  // there so the chat is usable. Runs once after mount (not during SSR/initial
  // render) to avoid a hydration mismatch; desktop keeps the panel open.
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) setRightOpen(false);
  }, []);

  // The logistics-hub map needs the whole screen on a phone: collapse the
  // sidebar to its rail when the map opens on a narrow viewport.
  useEffect(() => {
    if (view === "map" && typeof window !== "undefined" && window.innerWidth < 760) setSidebarCollapsed(true);
  }, [view]);

  // Load workspace, folders, files, workspaces list, and latest conversation.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [wsRes, filesRes, listRes, colRes] = await Promise.all([
          api<{ workspace: Workspace; folders: Folder[] }>(`/api/workspaces/${id}`),
          api<{ files: FileItem[] }>(`/api/workspaces/${id}/files`),
          api<{ workspaces: Workspace[] }>(`/api/workspaces`),
          api<{ collections: Collection[] }>(`/api/collections`),
        ]);
        if (cancelled) return;
        setWorkspace(wsRes.workspace);
        setFolders(wsRes.folders);
        setFiles(filesRes.files);
        setWorkspaces(listRes.workspaces);
        setCollections(colRes.collections);
        // Conversations load in the separate (kind/entity)-driven effect below.
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

  // A page (re)load always opens a NEW chat; the history stays in the sidebar.
  // Only later switches of kind / collection reopen that context's latest chat.
  const firstListLoad = useRef(true);

  // Load conversations for the active (kind, entity). Re-runs whenever the user
  // switches chat kind or the selected collection — each kind/entity keeps its
  // own history (prototype `normalChats` / per-shipment / per-collection chats).
  useEffect(() => {
    if (!user) return;
    if (!endpoints) {
      // consolidated without a selected collection — nothing to load.
      setConversations([]);
      setConversationId(undefined);
      setInitialMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const conversations = await fetchConversations(endpoints);
        if (cancelled) return;
        setConversations(conversations);
        const opensNewChat = firstListLoad.current;
        firstListLoad.current = false;
        const latest = newestConversation(conversations);
        if (latest && !opensNewChat) {
          const conv = await fetchConversation(endpoints, latest.id);
          if (!cancelled) {
            setConversationId(conv.conversationId);
            setInitialMessages(conv.messages);
          }
        } else if (!cancelled) {
          setConversationId(undefined);
          setInitialMessages([]);
        }
      } catch {
        if (!cancelled) {
          setConversations([]);
          setConversationId(undefined);
          setInitialMessages([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, endpoints]);

  // Completeness for the top-bar step dots + right-panel badge.
  useEffect(() => {
    if (user) void loadShipmentData(id);
  }, [user, id, loadShipmentData]);

  useEffect(() => {
    if (user && workspace) void refreshChecklist();
  }, [user, workspace, refreshChecklist]);

  const onLog = useCallback((entry: LogEntry) => setLog((l) => [...l, entry]), []);
  const onPatch = useCallback(
    (partial: Partial<Workspace>) => setWorkspace((w) => (w ? { ...w, ...partial } : w)),
    []
  );

  // Persist shipment-survey state (answers + status) so it survives reloads.
  // Non-blocking: failure just means the survey can't resume, not that answers
  // are lost (they still flow to the agent as the submitted chat message).
  const persistSurvey = useCallback(
    (state: { answers?: SurveyAnswers; status: SurveyStatus }) => {
      onPatch({
        survey_status: state.status,
        ...(state.answers ? { survey_answers: state.answers } : {}),
      });
      void api(`/api/workspaces/${id}/survey`, { method: "PATCH", body: state }).catch(() => {});
    },
    [id, onPatch]
  );


  // Deterministic survey → intake: write contract_type/transport_mode/product_category
  // straight to the workspace so the sidebar reflects the survey immediately.
  const onSurveyIntake = useCallback(
    (patch: Partial<Record<SurveyIntakeField, string>>) => {
      void (async () => {
        try {
          const r = await api<{ workspace: Workspace }>(`/api/workspaces/${id}/intake`, {
            method: "PATCH",
            body: patch,
          });
          setWorkspace((w) => (w ? { ...w, ...r.workspace } : r.workspace));
        } catch {
          /* non-blocking */
        }
        invalidateShipment();
      })();
    },
    [id, invalidateShipment]
  );

  // After a supply chat turn the agent may have changed workspace context via tools;
  // re-fetch the workspace and refresh the sidebar so it never shows stale data.
  const onSupplyTurnComplete = useCallback(() => {
    void (async () => {
      try {
        const r = await api<{ workspace: Workspace; folders: Folder[] }>(`/api/workspaces/${id}`);
        setWorkspace(r.workspace);
        setFolders(r.folders);
      } catch {
        /* ignore */
      }
      invalidateShipment();
    })();
  }, [id, invalidateShipment]);

  const onUploadVersion = useCallback(
    async (replacesFileId: string, fileList: FileList) => {
      // A Збірник's file versions live in the FCL workspace.
      const target = fclId ? fclFiles : { upload, refreshFiles };
      await target.upload(versionsFile?.folderId ?? null, fileList, replacesFileId);
      await target.refreshFiles();
    },
    [upload, refreshFiles, versionsFile, fclId, fclFiles]
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
      notify("Не вдалося створити теку.");
    }
  }, [id, notify]);

  const refreshConversations = useCallback(async () => {
    if (!endpoints) return;
    try {
      setConversations(await fetchConversations(endpoints));
    } catch {
      /* ignore */
    }
  }, [endpoints]);

  const loadConversation = useCallback(
    async (convId: string) => {
      if (!endpoints || convId === conversationId) return;
      try {
        const conv = await fetchConversation(endpoints, convId);
        setConversationId(conv.conversationId);
        setInitialMessages(conv.messages);
      } catch {
        notify("Не вдалося завантажити розмову.");
      }
    },
    [endpoints, conversationId, notify]
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

  // Shell actions.
  const selectShipment = useCallback((wid: string) => router.push(`/workspaces/${wid}`), [router]);

  // Collections (Збірник). Kept in the app store; created/selected/deleted here.
  const selectCollection = useCallback(
    (cid: string) => setActiveCollectionId(cid),
    [setActiveCollectionId]
  );
  const newCollection = useCallback(async () => {
    // Like a new shipment — let the user name the сборник (optional).
    const name = (window.prompt("Назва збірника (необов'язково)") ?? "").trim();
    try {
      const body: { status: string; number?: string } = { status: "active" };
      if (name) body.number = name;
      const { collection } = await api<{ collection: Collection }>(`/api/collections`, { body });
      addCollection(collection); // prepends + sets it active
      setChatKind("consolidated");
    } catch {
      notify("Не вдалося створити збірник.");
    }
  }, [addCollection, setChatKind, notify]);
  const deleteActiveCollection = useCallback(async () => {
    if (!activeCollectionId) return;
    const ok = window.confirm(
      "Видалити збірник?\n\nБуде видалено всі файли, теки та чати. Дію не можна скасувати."
    );
    if (!ok) return;
    try {
      await api(`/api/collections/${activeCollectionId}`, { method: "DELETE" });
      removeCollection(activeCollectionId);
    } catch {
      notify("Не вдалося видалити збірник.");
    }
  }, [activeCollectionId, removeCollection, notify]);

  const renameActiveCollection = useCallback(async () => {
    if (!activeCollectionId) return;
    const cur = collections.find((c) => c.id === activeCollectionId);
    const next = (window.prompt("Назва збірника", cur?.number ?? "") ?? "").trim();
    if (!next || next === cur?.number) return;
    try {
      await api(`/api/collections/${activeCollectionId}`, {
        method: "PATCH",
        body: { number: next },
      });
      setCollections(
        collections.map((c) => (c.id === activeCollectionId ? { ...c, number: next } : c))
      );
    } catch {
      notify("Не вдалося перейменувати збірник.");
    }
  }, [activeCollectionId, collections, setCollections, notify]);

  // Resolve the collection to analyse into — or AUTO-CREATE one (like a new
  // shipment) so a manifest can be analysed without picking a сборник first.
  const ensureCollectionForAnalysis = useCallback(
    async (suggestedName?: string): Promise<string | null> => {
      if (activeCollectionId) return activeCollectionId;
      try {
        const body: { status: string; number?: string } = { status: "active" };
        const name = suggestedName?.trim();
        if (name) body.number = name; // name the сборник after the manifest
        const { collection } = await api<{ collection: Collection }>(`/api/collections`, { body });
        addCollection(collection); // prepends to the list + sets it active
        return collection.id;
      } catch {
        return null;
      }
    },
    [activeCollectionId, addCollection]
  );

  // Load the conversation the analysis was posted into, so its per-product answer
  // shows in the chat thread (and appears in the sidebar chat list).
  const showAnalysisConversation = useCallback(async (cid: string, convId: string) => {
    try {
      const conv = await api<{ conversationId: string; messages: Message[] }>(
        `/api/collections/${cid}/conversations/${convId}`
      );
      setConversationId(conv.conversationId);
      setInitialMessages(conv.messages);
      const list = await api<{ conversations: ConversationMeta[] }>(
        `/api/collections/${cid}/conversations`
      );
      setConversations(list.conversations);
    } catch {
      /* ignore */
    }
  }, []);

  const onAnalysisResult = useCallback(
    (r: AnalysisResult, meta: { conversationId?: string; collectionId: string }) => {
      setAnalysis(r);
      setShowIntake(false);
      if (meta.conversationId) void showAnalysisConversation(meta.collectionId, meta.conversationId);
    },
    [showAnalysisConversation]
  );

  // Chat-triggered analysis (paperclip file / pasted Google Sheets link): runs the
  // analyze endpoint DIRECTLY (not via the agent), which posts the exact per-product
  // Markdown into the conversation — so the answer isn't reformatted into a table.
  // The in-flight analyze stream — aborted on unmount (leaving the page).
  const analyzeAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => analyzeAbortRef.current?.abort(), []);

  const analyzeManifest = useCallback(
    async (source: { file?: File; url?: string }) => {
      if (analyzeProgress) return; // one at a time
      const suggestedName = source.file
        ? source.file.name.replace(/\.[^.]+$/, "").slice(0, 80)
        : "Google Sheets";
      const cid = await ensureCollectionForAnalysis(suggestedName);
      if (!cid) {
        notify("Не вдалося визначити збірник.");
        return;
      }
      const body = analyzeBody(source.file ? { file: source.file } : { input: source.url ?? "" }, conversationId);
      setAnalyzeProgress({ pct: 0, step: "Готую аналіз…" });
      analyzeAbortRef.current?.abort();
      const ctrl = new AbortController();
      analyzeAbortRef.current = ctrl;
      const outcome = await runAnalysis(cid, body, (e) => setAnalyzeProgress(e), ctrl.signal);
      if (analyzeAbortRef.current === ctrl) analyzeAbortRef.current = null;
      setAnalyzeProgress(null);
      if (outcome.kind === "done") {
        setAnalysis(outcome.done.analysis);
        if (outcome.done.conversationId) void showAnalysisConversation(cid, outcome.done.conversationId);
      } else if (outcome.kind === "error") {
        notify(outcome.message);
      }
    },
    [analyzeProgress, ensureCollectionForAnalysis, conversationId, showAnalysisConversation, notify]
  );

  // After a consolidated chat turn (analysis may have been run from chat), pull the
  // collection's latest analysis so the toolbar/table/export reflect it.
  const reloadLatestAnalysis = useCallback(async () => {
    if (!activeCollectionId) return;
    try {
      const latest = await fetchLatestAnalysis(activeCollectionId);
      if (latest) setAnalysis(latest);
    } catch {
      /* ignore */
    }
  }, [activeCollectionId]);

  // ── Збірник (FCL) folders + files: the lot folders appear as files are read ──
  const refreshColFolders = useCallback(async () => {
    if (!fclId) return;
    try {
      const colRes = await api<{ collection: Collection; folders: Folder[] }>(`/api/collections/${fclId}`);
      setColFolders(colRes.folders);
    } catch {
      /* keep the last list */
    }
  }, [fclId]);

  useEffect(() => {
    if (!fclId) {
      setColFolders([]);
      return;
    }
    void refreshColFolders();
    void fclFiles.refreshFiles().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fclId, refreshColFolders]);

  // When files finish reading or move between lots, the verdicts and lot folders
  // change server-side: refresh both (debounced over a burst of file events).
  const fclFilesKey = useMemo(
    () => fclFiles.files.map((f) => `${f.id}:${f.status}:${f.folderId ?? ""}`).join("|"),
    [fclFiles.files]
  );
  useEffect(() => {
    if (!fclId) return;
    const t = setTimeout(() => {
      void refreshColFolders();
      void fcl.reload();
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fclId, fclFilesKey]);

  const colCreateFolder = useCallback(async () => {
    if (!fclId) return;
    const name = window.prompt("Назва теки")?.trim();
    if (!name) return;
    try {
      await api(`/api/workspaces/${fclId}/folders`, { body: { name } });
      await refreshColFolders();
    } catch {
      notify("Не вдалося створити теку.");
    }
  }, [fclId, refreshColFolders, notify]);

  const openLot = useCallback((lotId: string) => {
    setFclScope(lotId);
    setRightTab("complete");
  }, []);

  const onFclTurnComplete = useCallback(() => {
    void reloadLatestAnalysis();
    void refreshColFolders();
    void fclFiles.refreshFiles().catch(() => {});
    void fcl.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadLatestAnalysis, refreshColFolders, fcl.reload]);

  // Load the collection's latest persisted analysis (so a сборник keeps its
  // analysis instead of losing it on reload / switch). Cleared when leaving
  // consolidated or with no collection selected.
  useEffect(() => {
    setShowIntake(false);
    if (chatKind !== "consolidated" || !activeCollectionId) {
      setAnalysis(null);
      return;
    }
    let cancelled = false;
    setAnalysis(null);
    (async () => {
      try {
        const latest = await fetchLatestAnalysis(activeCollectionId);
        if (!cancelled) setAnalysis(latest);
      } catch {
        if (!cancelled) setAnalysis(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCollectionId, chatKind]);

  const newShipment = useCallback(async () => {
    const number = window.prompt("Номер постачання (необов'язково)") ?? "";
    try {
      const { workspace } = await api<{ workspace: Workspace }>(`/api/workspaces`, {
        body: { number: number.trim() || undefined, status: "active" },
      });
      router.push(`/workspaces/${workspace.id}`);
    } catch {
      notify("Не вдалося створити постачання.");
    }
  }, [router, notify]);

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
      notify("Не вдалося видалити постачання.");
    }
  }, [id, workspace, workspaces, router, notify]);

  const renameShipment = useCallback(async () => {
    if (!workspace) return;
    const next = (window.prompt("Номер постачання", workspace.number ?? "") ?? "").trim();
    if (!next || next === workspace.number) return;
    try {
      await api(`/api/workspaces/${id}`, { method: "PATCH", body: { number: next } });
      onPatch({ number: next });
      setWorkspaces((ws) => ws.map((w) => (w.id === id ? { ...w, number: next } : w)));
    } catch {
      notify("Не вдалося перейменувати постачання.");
    }
  }, [id, workspace, onPatch, notify]);

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
    a.push({
      id: "ai-settings",
      label: "Налаштування AI",
      hint: "BYOK",
      icon: <LnSettings size={17} />,
      keywords: "byok ключ провайдер openai gemini claude openrouter engine",
      run: () => setAiSettingsOpen(true),
    });
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

  // Composer entity selector: shipments for supply, collections for consolidated,
  // hidden (null) for the global normal chat.
  const composerSelector: EntitySelector | null =
    chatKind === "supply"
      ? {
          label: "Постачання",
          value: workspace.id,
          options: workspaces.map((w) => ({
            id: w.id,
            label: `№${w.number ?? "—"}${w.supplier ? ` · ${w.supplier}` : ""}`,
          })),
          onChange: selectShipment,
        }
      : chatKind === "consolidated"
        ? {
            label: "Збірник",
            value: activeCollectionId ?? "",
            options: collections.map((c) => ({
              id: c.id,
              label: `${c.number ?? "Збірник"}${c.supplier ? ` · ${c.supplier}` : ""}`,
            })),
            onChange: selectCollection,
          }
        : null;

  return (
    <div style={{ height: "100vh", display: "flex", overflow: "hidden", background: "var(--chat)" }}>
      <input
        ref={paletteUploadRef}
        type="file"
        multiple
        hidden
        accept=".pdf,.docx,.doc,.xlsx,.xls,.csv,.png,.jpg,.jpeg,.zip"
        onChange={(e) => {
          if (e.target.files && e.target.files.length) uploadSmart(null, e.target.files);
          e.target.value = "";
        }}
      />

      <SidebarNav
        workspaces={workspaces}
        current={workspace}
        collections={collections}
        activeCollectionId={activeCollectionId}
        chatKind={chatKind}
        onChangeKind={setChatKind}
        view={view}
        onSetView={setView}
        conversations={conversations}
        currentConversationId={conversationId}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        onNewChat={newChat}
        onNewShipment={newShipment}
        onSelectShipment={selectShipment}
        onRenameShipment={renameShipment}
        onDeleteShipment={deleteShipment}
        onSelectCollection={selectCollection}
        onNewCollection={newCollection}
        onRenameActiveCollection={renameActiveCollection}
        onDeleteActiveCollection={deleteActiveCollection}
        onSelectConversation={loadConversation}
      />

      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "var(--chat)" }}>
        {/* Supply-oriented top bar (number / completeness / supplier). Hidden in
            the Збірний view — a сборник has no supply completeness, so it would
            just be a misleading duplicate bar. */}
        {!(view === "chat" && chatKind === "consolidated") && (
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
            // Full постачання header only for the supply chat; звичайний / Новини /
            // Карта get a minimal bar with just the theme/title.
            variant={view === "chat" && chatKind === "supply" ? "supply" : "minimal"}
            title={
              view === "news"
                ? "Новини"
                : view === "map"
                  ? "Логістичний хаб"
                  : view === "calendar"
                    ? "Календар логістів"
                    : conversations.find((c) => c.id === conversationId)?.title?.trim() ||
                    "Новий чат"
            }
          />
        )}
        <div style={{ flex: 1, minHeight: 0 }}>
          {view === "news" ? (
            <NewsView />
          ) : view === "map" ? (
            <MapView workspaceId={id} />
          ) : view === "calendar" ? (
            <CalendarView />
          ) : chatKind === "consolidated" ? (
            /* Збірний: тулбар (таблиця/експорт/новий аналіз) + опційна картка/ввід,
               а знизу — чат обговорення, прив'язаний до збірника (відповідь аналізу
               приходить у чат блоками по кожному продукту). Якщо збірник ще не
               обрано — лише ввід, який АВТОМАТИЧНО створює збірник при аналізі. */
            <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
              {/* Toolbar — only when there is an analysis to act on. */}
              {analysis ? (
                <div
                  style={{
                    flex: "none",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                    padding: "10px 20px",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                    Аналіз «{analysis.sheet}»
                  </span>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    до сплати {Math.round(analysis.totals.payable).toLocaleString("uk-UA")} $ ·{" "}
                    {analysis.totals.count} поз.
                  </span>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    · звіт та експорт — у вкладці «Архів»; новий аналіз — прямо з чату (посилання / таблиця / 📎)
                  </span>
                  <div style={{ flex: 1 }} />
                </div>
              ) : null}

              {/* Chat-triggered analysis progress (paperclip / pasted link). */}
              {analyzeProgress ? (
                <div
                  style={{
                    flex: "none",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 20px",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <IconSpinner size={15} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>
                      {analyzeProgress.step} · {analyzeProgress.pct}%
                    </div>
                    <div
                      style={{
                        height: 4,
                        background: "var(--hover)",
                        borderRadius: 999,
                        marginTop: 4,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${analyzeProgress.pct}%`,
                          height: "100%",
                          background: "var(--accent)",
                          transition: "width .3s ease",
                        }}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {/* On-demand manifest intake ABOVE existing results (only when there
                  is already an analysis — «Новий аналіз» toolbar toggle). Without an
                  analysis the intake is shown CENTERED in the main area below instead
                  of splitting the screen. */}
              {analysis && showIntake ? (
                <div
                  style={{
                    flex: "0 0 auto",
                    maxHeight: "48%",
                    overflowY: "auto",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div style={{ padding: "14px 20px", maxWidth: 720, margin: "0 auto" }}>
                    <AnalyzePanel
                      resolveCollectionId={ensureCollectionForAnalysis}
                      conversationId={conversationId}
                      onResult={onAnalysisResult}
                      onOpenAiSettings={() => setAiSettingsOpen(true)}
                    />
                  </div>
                </div>
              ) : null}

              {/* The rich structured analysis now lives in the «Архів» preview —
                  the chat shows the per-product Markdown tables inline. */}

              {/* Main area: centered intake (when explicitly requested and no
                  analysis yet — single view, NO split), else the discussion chat
                  (analysis can be run straight from here — paste a link/table or
                  attach a file via the paperclip; the answer lands as per-product
                  blocks). New chat = centered welcome. */}
              <div style={{ flex: 1, minHeight: 0 }}>
                {!analysis && showIntake ? (
                  <div
                    style={{
                      height: "100%",
                      overflowY: "auto",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: 24,
                    }}
                  >
                    <div style={{ width: "100%", maxWidth: 720 }}>
                      <AnalyzePanel
                        resolveCollectionId={ensureCollectionForAnalysis}
                        conversationId={conversationId}
                        onResult={onAnalysisResult}
                        onOpenAiSettings={() => setAiSettingsOpen(true)}
                      />
                    </div>
                  </div>
                ) : endpoints ? (
                  <Chat
                    key={`consolidated-${activeCollectionId ?? "none"}-${chatSeq}`}
                    postPath={endpoints.postPath}
                    chatKind={chatKind}
                    onChangeKind={setChatKind}
                    selector={composerSelector}
                    conversationId={conversationId}
                    initialMessages={initialMessages}
                    onConversationStarted={onConversationStarted}
                    onLog={onLog}
                    onTurnComplete={onFclTurnComplete}
                    onAnalyzeManifest={analyzeManifest}
                    folders={colFolders}
                    onUploadAndClassify={fclFiles.uploadAndClassify}
                    onMoveFile={fclFiles.moveFile}
                    docsStatus={fclFiles.docsStatus}
                    placeholder="Прикріпіть документи збірника 📎, вставте посилання на маніфест, або спитайте про партії…"
                    emptyTitle="Збірник (FCL)"
                    emptySubtitle={
                      <>
                        Завантажте документи контейнера — я прочитаю їх, розкладу по партіях
                        (одна партія = один постачальник) і перевірю кожну партію та весь FCL:
                        комплектність, розбіжності, ризики, маніфест ↔ інвойси, CIF&nbsp;/&nbsp;мито&nbsp;/&nbsp;ПДВ.
                      </>
                    }
                    emptyStarters={CONSOLIDATED_STARTERS}
                  />
                ) : (
                  /* No сборник yet — centered intake that AUTO-CREATES one on analysis. */
                  <div
                    style={{
                      height: "100%",
                      overflowY: "auto",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: 24,
                    }}
                  >
                    <div style={{ width: "100%", maxWidth: 720 }}>
                      <AnalyzePanel
                        resolveCollectionId={ensureCollectionForAnalysis}
                        conversationId={conversationId}
                        onResult={onAnalysisResult}
                        onOpenAiSettings={() => setAiSettingsOpen(true)}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : !endpoints ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
              <div style={{ maxWidth: 440, textAlign: "center", color: "var(--muted)" }}>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
                  Оберіть постачання або збірник у сайдбарі, щоб почати роботу.
                </p>
              </div>
            </div>
          ) : (
            /* Звичайний / Постачання — агент-чат на всю висоту з долученням файлів
               (для обох типів файли йдуть у теки поточного постачання). */
            <Chat
              // NB: conversationId is intentionally NOT in the key. When a NEW
              // chat gets its server id after the first answer, remounting here
              // would reset the component to the (stale, empty) initialMessages
              // and wipe the just-streamed thread. Remount only on kind change or
              // an explicit new chat (chatSeq); loading another conversation flows
              // in through initialMessages instead.
              key={`${chatKind}-${chatSeq}`}
              postPath={endpoints.postPath}
              chatKind={chatKind}
              onChangeKind={setChatKind}
              selector={composerSelector}
              conversationId={conversationId}
              initialMessages={initialMessages}
              onConversationStarted={onConversationStarted}
              onLog={onLog}
              placeholder={
                chatKind === "normal"
                  ? "Запитайте про ЗЕД, митницю, документи або коди УКТ ЗЕД…"
                  : undefined
              }
              folders={folders}
              onUploadAndClassify={uploadAndClassify}
              onMoveFile={moveFile}
              docsStatus={chatKind === "supply" ? docsStatus : null}
              onTurnComplete={chatKind === "supply" ? onSupplyTurnComplete : undefined}
              onSurveyPersist={chatKind === "supply" ? persistSurvey : undefined}
              onSurveyIntake={chatKind === "supply" ? onSurveyIntake : undefined}
              surveyPrefilled={{
                contract_type: !!workspace.contract_type,
                transport_mode: !!workspace.transport_mode,
                product_category: !!workspace.product_category,
              }}
            />
          )}
        </div>
      </main>

      {rightOpen && view === "chat" && chatKind === "supply" && (
        <RightPanel
          tab={rightTab === "archive" || rightTab === "lots" ? "files" : rightTab}
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
                void moveFile(file.id, folderId).catch(() => notify("Не вдалося перемістити файл."));
              }}
              onReindex={reindexFile}
              onPreview={setPreviewFile}
              uploadProgress={uploadProgress}
            />
          }
          journal={<AgentLog entries={log} embedded />}
          complete={
            <ShipmentPanel
              workspaceId={id}
              workspace={workspace}
              onPatch={onPatch}
            />
          }
        />
      )}

      {rightOpen && view === "chat" && chatKind === "consolidated" && activeCollectionId && (
        <RightPanel
          tab={rightTab}
          onTab={setRightTab}
          onClose={() => setRightOpen(false)}
          badges={{
            files: fclFiles.files.filter((f) => f.isLatest !== false).length,
            lots: fcl.overview?.lots.length,
            complete: fcl.overview?.checklist.filter((c) => c.status === "missing").length,
          }}
          tabs={[
            { id: "files", label: "Файли" },
            { id: "lots", label: "Партії" },
            { id: "complete", label: "Комплектність" },
            { id: "archive", label: "Аналіз" },
            { id: "journal", label: "Журнал" },
          ]}
          files={
            <FilesTab
              workspaceNumber={collections.find((c) => c.id === activeCollectionId)?.number ?? null}
              folders={colFolders}
              files={fclFiles.files}
              onUpload={fclFiles.uploadSmart}
              onCreateFolder={colCreateFolder}
              onRenameFile={fclFiles.renameFile}
              onDeleteFile={fclFiles.deleteFile}
              onVersions={setVersionsFile}
              onMoveFile={(file, folderId) => {
                void fclFiles.moveFile(file.id, folderId).catch(() => notify("Не вдалося перемістити файл."));
              }}
              onReindex={fclFiles.reindexFile}
              onPreview={setPreviewFile}
              uploadProgress={fclFiles.uploadProgress}
            />
          }
          lots={
            <LotsTab
              fclId={activeCollectionId}
              overview={fcl.overview}
              loading={fcl.loading}
              reload={fcl.reload}
              onOpenLot={openLot}
              onSortInbox={fclFiles.sortInbox}
              notify={notify}
            />
          }
          complete={
            <FclCompleteness
              fclId={activeCollectionId}
              number={collections.find((c) => c.id === activeCollectionId)?.number ?? "zbirnyk"}
              overview={fcl.overview}
              version={fcl.version}
              reload={fcl.reload}
              scope={fclScope}
              onScope={setFclScope}
              notify={notify}
            />
          }
          archive={<ArchiveList />}
          journal={<AgentLog entries={log} embedded />}
        />
      )}

      {paletteOpen && (
        <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />
      )}

      {versionsFile && (
        <VersionsModal
          workspaceId={fclId ?? id}
          fileId={versionsFile.id}
          onClose={() => setVersionsFile(null)}
          onUploadVersion={onUploadVersion}
        />
      )}
      {previewFile && (
        <FilePreviewModal workspaceId={fclId ?? id} file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
      {aiSettingsOpen && <AiSettingsModal onClose={() => setAiSettingsOpen(false)} />}
      {notice && <NoticeBanner text={notice.text} tone={notice.tone} onClose={closeNotice} />}
    </div>
  );
}
