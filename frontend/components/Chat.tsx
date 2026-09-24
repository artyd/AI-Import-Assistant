"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatKind, Citation, Folder, Message } from "@/lib/types";
import { streamChat } from "@/lib/sse";
import { folderLabel } from "@/lib/folderLabels";
import { Markdown } from "./Markdown";
import type { LogEntry } from "./AgentLog";
import {
  IconSend,
  IconAttach,
  IconSpinner,
  IconFile,
  IconFolder,
  IconCheck,
  IconSearch,
} from "./icons";
import { LnChevronDown } from "./LineIcons";

const UPLOAD_ACCEPT = ".pdf,.docx,.doc,.xlsx,.xls,.csv,.png,.jpg,.jpeg";
const ACCEPT_EXT = UPLOAD_ACCEPT.split(",").map((s) => s.trim().toLowerCase());

let pasteSeq = 0;

// MIME → extension for every supported type. Drag/paste sources (and pasted
// screenshots) often hand us a file whose NAME has no extension — the server's
// allow-list is extension-based, so we must derive one from the MIME type or the
// upload is rejected as "no_valid_files".
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
};

// If the file's name already ends in a supported extension, keep it as-is.
// Otherwise, if its MIME type is one we support, rebuild the file with a proper
// extension (preserving any original base name so the user still recognises it).
function normalizeDropped(file: File): File {
  const lower = file.name.toLowerCase();
  if (ACCEPT_EXT.some((ext) => lower.endsWith(ext))) return file;
  const ext = MIME_EXT[file.type.toLowerCase()];
  if (ext) {
    const rawBase = file.name.trim().replace(/[/\\]+/g, "_");
    const base = rawBase || `файл-${++pasteSeq}`;
    return new File([file], `${base}.${ext}`, { type: file.type });
  }
  return file;
}

function isAccepted(file: File): boolean {
  const lower = file.name.toLowerCase();
  return ACCEPT_EXT.some((ext) => lower.endsWith(ext));
}

// Stable identity for a staged file (dedupe + chip key + removal). Two <input>
// picks of the same file on the same day collapse to one pending chip.
function fileKey(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

// Normalize + filter dropped/pasted files down to the supported types. Returns a
// plain File[] (no DataTransfer round-trip — that can silently drop filenames,
// which the server's extension allow-list then rejects).
function acceptFiles(files: File[]): File[] {
  return files.map(normalizeDropped).filter(isAccepted);
}

export interface UploadClassifyOutcome {
  fileId: string;
  name: string;
  folderName: string | null;
}

// The composer's kind switcher + entity selector (see prototype `typeTabs` /
// `selectorLabel`/`selectorOptions`). The selector is hidden for the `normal`
// kind (no entity), shown for `supply` (Постачання) and `consolidated` (Збірник).
export interface EntitySelector {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}

export const CHAT_TYPES: { id: ChatKind; label: string }[] = [
  { id: "normal", label: "Звичайний" },
  { id: "supply", label: "Постачання" },
  { id: "consolidated", label: "Збірний" },
];

interface Props {
  // Kind-specific POST endpoint for streaming (see resolveChatEndpoints).
  postPath: string;
  chatKind: ChatKind;
  onChangeKind: (k: ChatKind) => void;
  selector?: EntitySelector | null;
  conversationId?: string;
  initialMessages: Message[];
  onConversationStarted: (id: string) => void;
  onLog: (entry: LogEntry) => void;
  placeholder?: string;
  // Empty-state (new-chat) customisation. Defaults suit the supply/postачання chat.
  emptyTitle?: string;
  emptySubtitle?: React.ReactNode;
  emptyStarters?: { text: string; icon: React.ReactNode }[];
  emptyAction?: React.ReactNode;
  // Fired after every assistant turn completes (used to refresh side state, e.g.
  // reload the latest analysis when it was triggered from the consolidated chat).
  onTurnComplete?: () => void;
  // Consolidated: run the manifest analysis DIRECTLY (not via the agent) so the
  // exact per-product answer lands in the thread. Triggered by the paperclip (a
  // picked xlsx/csv) or by pasting a Google Sheets link into the composer.
  onAnalyzeManifest?: (source: { file?: File; url?: string }) => void;
  // File intake (paperclip auto-file flow) — supply only. When these are omitted
  // the composer's attach/drag/paste are disabled (normal has no files;
  // consolidated files are uploaded via the right-panel Files tab in this phase).
  folders?: Folder[];
  onUploadAndClassify?: (files: File[]) => Promise<UploadClassifyOutcome[]>;
  onMoveFile?: (fileId: string, folderId: string) => Promise<void>;
}

// Local-only chat items for the paperclip flow. These are NOT persisted to the
// conversation (they don't go through the agent/SSE); on reload they vanish, but
// the file's final folder is reflected in the file tree, so no data is lost.
type ClassifyCardState =
  | "uploading"
  | "classifying"
  | "filed"
  | "needs_pick"
  | "moving"
  | "error";

interface ClassifyCard {
  kind: "classify";
  id: string;
  fileId: string | null;
  name: string;
  state: ClassifyCardState;
  folderName?: string;
}

type ChatItem = ({ kind: "message" } & Message) | ClassifyCard;

let cardSeq = 0;

function hhmm() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

let logSeq = 0;
function labelToolCall(tool: string, input: Record<string, unknown>): string {
  if (tool === "search_documents")
    return `Пошук: «${String(input.query ?? "")}»`;
  if (tool === "read_file")
    return `Читаю: ${String(input.path ?? input.file ?? input.fileName ?? "")}`;
  if (tool === "list_files") return "Перелік файлів";
  return `Інструмент: ${tool}`;
}

export function Chat({
  postPath,
  chatKind,
  onChangeKind,
  selector,
  conversationId,
  initialMessages,
  onConversationStarted,
  onLog,
  placeholder,
  emptyTitle,
  emptySubtitle,
  emptyStarters,
  emptyAction,
  onTurnComplete,
  onAnalyzeManifest,
  folders,
  onUploadAndClassify,
  onMoveFile,
}: Props) {
  // File intake is only wired when the host supplies the workspace file handlers.
  const fileIntake = !!(onUploadAndClassify && onMoveFile && folders);
  const [items, setItems] = useState<ChatItem[]>(() =>
    initialMessages.map((m) => ({ kind: "message" as const, ...m }))
  );
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Files chosen via paperclip/drag/paste are STAGED here (chips above the input)
  // and only uploaded when the message is sent — never on pick. Cleared on send.
  const [pending, setPending] = useState<File[]>([]);
  // "Highlight-to-ask" (ChatGPT-style): a fragment selected from an assistant
  // answer, staged as a quote chip above the composer to ask a follow-up about it.
  const [quote, setQuote] = useState<string | null>(null);
  // The floating "ask about this" button shown at the current selection.
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);
  const convRef = useRef<string | undefined>(conversationId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamTextRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const manifestInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Drag events fire on every child; count enters/leaves so the overlay only
  // clears when the cursor truly leaves the chat container.
  const dragDepth = useRef(0);

  // Reset the thread ONLY when a different conversation is loaded (initialMessages
  // changes) — NOT when conversationId flips undefined→id after the first answer
  // of a brand-new chat (that would wipe the just-streamed messages). convRef is
  // already kept in sync inside onDone, and is re-synced here on a real load.
  useEffect(() => {
    setItems(initialMessages.map((m) => ({ kind: "message" as const, ...m })));
    convRef.current = conversationId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, streaming]);

  // Highlight-to-ask: after a mouse selection inside an assistant answer, show a
  // small floating "ask about this" button anchored to the selection. Ignores
  // selections outside assistant bubbles (user text, file cards, empty ranges).
  const onThreadMouseUp = useCallback(() => {
    const s = window.getSelection();
    if (!s || s.isCollapsed) {
      setSel(null);
      return;
    }
    const text = s.toString().trim();
    if (text.length < 2) {
      setSel(null);
      return;
    }
    const node = s.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    if (!el || !el.closest('[data-role="assistant"]')) {
      setSel(null);
      return;
    }
    const rect = s.getRangeAt(0).getBoundingClientRect();
    setSel({ text, x: rect.left + rect.width / 2, y: rect.top });
  }, []);

  // Dismiss the floating button on scroll (its anchor would drift otherwise).
  useEffect(() => {
    if (!sel) return;
    const el = scrollRef.current;
    const hide = () => setSel(null);
    el?.addEventListener("scroll", hide, { passive: true });
    return () => el?.removeEventListener("scroll", hide);
  }, [sel]);

  const askAboutSelection = useCallback(() => {
    if (!sel) return;
    setQuote(sel.text);
    setSel(null);
    window.getSelection()?.removeAllRanges();
    // Focus the composer so the user can type the follow-up straight away.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [sel]);

  const patchCard = useCallback(
    (cardId: string, patch: Partial<ClassifyCard>) =>
      setItems((list) =>
        list.map((it) =>
          it.kind === "classify" && it.id === cardId ? { ...it, ...patch } : it
        )
      ),
    []
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      // One card per selected file, in order, starting at "uploading".
      const cards: ClassifyCard[] = files.map((f) => ({
        kind: "classify",
        id: `card-${cardSeq++}`,
        fileId: null,
        name: f.name,
        state: "uploading",
      }));
      setItems((list) => [...list, ...cards]);

      if (!onUploadAndClassify) return;
      const outcomes = await onUploadAndClassify(files);

      // Match outcomes back to cards positionally (upload preserves order). Any
      // file the server rejected has no outcome → mark that card as an error.
      cards.forEach((card, i) => {
        const outcome = outcomes[i];
        if (!outcome) {
          patchCard(card.id, { state: "error" });
          return;
        }
        patchCard(card.id, {
          fileId: outcome.fileId,
          name: outcome.name,
          folderName: outcome.folderName ?? undefined,
          state: outcome.folderName ? "filed" : "needs_pick",
        });
      });
    },
    [onUploadAndClassify, patchCard]
  );

  const hasFiles = (dt: DataTransfer | null) =>
    !!dt && Array.from(dt.types).includes("Files");

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);

  const ingest = useCallback(
    (raw: File[]) => {
      if (streaming || !fileIntake) return;
      const files = acceptFiles(raw);
      if (files.length) {
        setNotice(null);
        // STAGE, don't upload: the files become chips above the composer and are
        // uploaded + classified only when the message is sent. Dedupe by identity
        // so re-picking the same file doesn't add a second chip.
        setPending((prev) => {
          const seen = new Set(prev.map(fileKey));
          const add = files.filter((f) => !seen.has(fileKey(f)));
          return add.length ? [...prev, ...add] : prev;
        });
      } else if (raw.length) {
        // Files arrived but none were a supported type — say so instead of
        // silently doing nothing.
        setNotice(
          "Ці файли не підтримуються. Дозволені: PDF, DOCX, XLSX, CSV, PNG, JPG."
        );
      }
    },
    [streaming, fileIntake]
  );

  const removePending = useCallback((f: File) => {
    setPending((prev) => prev.filter((x) => fileKey(x) !== fileKey(f)));
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      ingest(Array.from(e.dataTransfer.files));
    },
    [ingest]
  );

  // Paste (Ctrl+V) of files or a screenshot into the composer. Chrome exposes
  // pasted files both as `files` and as `items[].getAsFile()`; read both and
  // dedupe. Only swallow the paste when it actually carries files, so pasting
  // plain text still works.
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const fromItems = Array.from(e.clipboardData.items)
        .filter((it) => it.kind === "file")
        .map((it) => it.getAsFile())
        .filter((f): f is File => f != null);
      const collected = [...Array.from(e.clipboardData.files), ...fromItems];
      // Dedupe (a file can appear in both lists).
      const seen = new Set<string>();
      const files = collected.filter((f) => {
        const key = `${f.name}:${f.size}:${f.lastModified}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!files.length) return;
      e.preventDefault();
      ingest(files);
    },
    [ingest]
  );

  const pickFolder = useCallback(
    async (card: ClassifyCard, folder: Folder) => {
      if (!card.fileId || !onMoveFile) return;
      patchCard(card.id, { state: "moving" });
      try {
        await onMoveFile(card.fileId, folder.id);
        patchCard(card.id, { state: "filed", folderName: folder.name });
      } catch {
        patchCard(card.id, { state: "needs_pick" });
      }
    },
    [onMoveFile, patchCard]
  );

  const runMessage = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || streaming) return;
    setInput("");
    setStreaming(true);
    streamTextRef.current = "";

    const userMsg: ChatItem = {
      kind: "message",
      id: `local-${Date.now()}`,
      role: "user",
      content: text,
    };
    const assistantId = `stream-${Date.now()}`;
    setItems((m) => [
      ...m,
      userMsg,
      { kind: "message", id: assistantId, role: "assistant", content: "" },
    ]);

    const updateAssistant = (patch: Partial<Message>) =>
      setItems((m) =>
        m.map((it) =>
          it.kind === "message" && it.id === assistantId
            ? { ...it, ...patch }
            : it
        )
      );

    try {
      await streamChat(
        postPath,
        { message: text, conversationId: convRef.current },
        {
          onToken: (e) => {
            streamTextRef.current += e.text;
            updateAssistant({ content: streamTextRef.current });
          },
          onToolCall: (e) =>
            onLog({
              id: `l${logSeq++}`,
              time: hhmm(),
              text: labelToolCall(e.tool, e.input),
              kind: "call",
            }),
          onToolResult: (e) =>
            onLog({
              id: `l${logSeq++}`,
              time: hhmm(),
              text: e.summary,
              kind: "result",
            }),
          onDone: (e) => {
            updateAssistant({
              id: e.messageId || assistantId,
              content: e.message || streamTextRef.current,
              citations: e.citations,
            });
            if (e.conversationId && convRef.current !== e.conversationId) {
              convRef.current = e.conversationId;
              onConversationStarted(e.conversationId);
            }
            onTurnComplete?.();
          },
          onError: (e) =>
            updateAssistant({
              content:
                (streamTextRef.current ? streamTextRef.current + "\n\n" : "") +
                `⚠️ ${e.message}`,
            }),
        }
      );
    } catch {
      updateAssistant({ content: "⚠️ Помилка з’єднання з сервером." });
    } finally {
      setStreaming(false);
    }
  }, [streaming, postPath, onConversationStarted, onLog, onTurnComplete]);

  // On send: first upload + classify any staged files (they show as classify
  // cards in the thread, exactly like the old inline flow), then stream the text
  // message if there is one. Sending is allowed with files only, text only, or both.
  const send = useCallback(async () => {
    if (streaming) return;
    const text = input.trim();
    const files = pending;
    const q = quote;
    if (!text && files.length === 0 && !q) return;

    // Consolidated: a pasted Google Sheets link runs the analysis DIRECTLY (exact
    // per-product blocks), not through the agent (which would reformat it).
    if (onAnalyzeManifest && !q && files.length === 0) {
      const m = text.match(/https?:\/\/docs\.google\.com\/spreadsheets\/\S+/i);
      if (m) {
        setInput("");
        onAnalyzeManifest({ url: m[0] });
        return;
      }
    }
    if (files.length) {
      setPending([]);
      await handleFiles(files);
    }
    if (text || q) {
      // When a fragment is quoted, prepend it as context so the agent answers
      // about that exact excerpt. A quote with no question ⇒ "explain it".
      const composed = q
        ? `Стосовно цього фрагмента попередньої відповіді:\n«${q}»\n\n${text || "Поясни детальніше."}`
        : input;
      if (q) setQuote(null);
      await runMessage(composed);
    }
  }, [streaming, input, pending, quote, handleFiles, runMessage, onAnalyzeManifest]);

  // Which action the composer paperclip performs: manifest analyse (consolidated)
  // or the supply auto-file staging flow.
  const attachAction = onAnalyzeManifest
    ? () => manifestInputRef.current?.click()
    : fileIntake
      ? () => fileInputRef.current?.click()
      : undefined;

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="chat-root"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--chat)",
      }}
    >
      {sel && (
        <button
          // preventDefault on mousedown so clicking doesn't clear the selection
          // before onClick reads it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={askAboutSelection}
          style={{
            position: "fixed",
            left: sel.x,
            top: Math.max(sel.y - 44, 8),
            transform: "translateX(-50%)",
            zIndex: 60,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 32,
            padding: "0 12px",
            background: "var(--accent)",
            color: "var(--accentTx)",
            border: "none",
            borderRadius: 16,
            boxShadow: "0 6px 18px var(--accentSoft)",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ fontWeight: 800, fontSize: 15, lineHeight: 1 }}>„“</span> Спитати про це
        </button>
      )}
      {dragging && (
        <div
          style={{
            position: "absolute",
            inset: 12,
            zIndex: 20,
            borderRadius: 16,
            border: "2px dashed var(--accent)",
            background: "color-mix(in srgb, var(--accent) 8%, var(--chat))",
            display: "grid",
            placeItems: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              color: "var(--accent)",
              fontWeight: 600,
            }}
          >
            <IconAttach size={28} />
            <span>Відпустіть, щоб долучити файли</span>
            <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}>
              PDF, DOCX, XLSX, CSV, зображення
            </span>
          </div>
        </div>
      )}
      {/* Shared hidden file input (rendered once; whichever branch is mounted
          owns the ref). */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept={UPLOAD_ACCEPT}
        onChange={(e) => {
          if (e.target.files && e.target.files.length) ingest(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      {/* Manifest picker (consolidated): a single xlsx/csv → analyse directly. */}
      {onAnalyzeManifest && (
        <input
          ref={manifestInputRef}
          type="file"
          hidden
          accept=".xlsx,.xls,.csv"
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) onAnalyzeManifest({ file: f });
            e.target.value = "";
          }}
        />
      )}

      {items.length === 0 ? (
        /* ── Onboarding / new chat — centered, like the AI-chat empty state ── */
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "32px 24px",
            minHeight: 0,
            overflowY: "auto",
          }}
        >
          <div
            data-anim
            style={{ width: "100%", maxWidth: 680, animation: "fadeUp .5s ease both" }}
          >
            <div style={{ display: "flex", justifyContent: "center", margin: "0 0 22px" }}>
              <span
                style={{
                  flex: "none",
                  width: 60,
                  height: 60,
                  borderRadius: 17,
                  background: "var(--accent)",
                  color: "var(--accentTx)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 800,
                  fontSize: 31,
                  boxShadow: "0 10px 30px var(--accentSoft)",
                }}
              >
                Ш
              </span>
            </div>
            <h1
              style={{
                margin: "0 0 8px",
                fontWeight: 700,
                fontSize: 32,
                lineHeight: 1.15,
                textAlign: "center",
                color: "var(--text)",
              }}
            >
              {emptyTitle ?? "Чим допомогти по постачанню?"}
            </h1>
            <p
              style={{
                margin: "0 0 30px",
                fontSize: 15.5,
                lineHeight: 1.55,
                color: "var(--muted)",
                textAlign: "center",
              }}
            >
              {emptySubtitle ?? (
                <>
                  Штурман проіндексує документи, звірить чернетки, простежить
                  комплектність пакета й підкаже код УКТ&nbsp;ЗЕД.
                </>
              )}
            </p>
            {notice && <Notice text={notice} onClear={() => setNotice(null)} />}
            <Composer
              input={input}
              setInput={setInput}
              inputRef={inputRef}
              onPaste={onPaste}
              onSend={send}
              onAttach={attachAction}
              streaming={streaming}
              chatKind={chatKind}
              onChangeKind={onChangeKind}
              selector={selector}
              placeholder={placeholder}
              pending={pending}
              onRemovePending={removePending}
              quote={quote}
              onClearQuote={() => setQuote(null)}
            />
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: 9,
                marginTop: 18,
              }}
            >
              {(emptyStarters ?? STARTERS).map((s) => (
                <button
                  key={s.text}
                  onClick={() => runMessage(s.text)}
                  disabled={streaming}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    height: 38,
                    padding: "0 15px",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 20,
                    color: "var(--text)",
                    fontSize: 13,
                    cursor: streaming ? "default" : "pointer",
                  }}
                >
                  <span style={{ color: "var(--accent)", display: "flex" }}>{s.icon}</span>
                  {s.text}
                </button>
              ))}
            </div>
            {emptyAction ? (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
                {emptyAction}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        /* ── Conversation thread ── */
        <>
          <div
            ref={scrollRef}
            onMouseUp={onThreadMouseUp}
            style={{ flex: 1, overflowY: "auto", padding: "24px 0" }}
          >
            <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 28px" }}>
              <DateSeparator />
              {items.map((it) =>
                it.kind === "classify" ? (
                  <ClassifyBubble key={it.id} card={it} folders={folders ?? []} onPick={pickFolder} />
                ) : it.role === "user" ? (
                  <UserBubble key={it.id} text={it.content} />
                ) : (
                  <AssistantBubble
                    key={it.id}
                    text={it.content}
                    citations={it.citations}
                    pending={streaming && it.content === ""}
                  />
                )
              )}
            </div>
          </div>

          <div style={{ flex: "none", padding: "8px 28px 20px" }}>
            <div style={{ maxWidth: 760, margin: "0 auto" }}>
              {notice && <Notice text={notice} onClear={() => setNotice(null)} />}
              <Composer
                input={input}
                setInput={setInput}
                inputRef={inputRef}
                onPaste={onPaste}
                onSend={send}
                onAttach={attachAction}
                streaming={streaming}
                chatKind={chatKind}
                onChangeKind={onChangeKind}
                selector={selector}
                placeholder={placeholder}
                pending={pending}
                onRemovePending={removePending}
                quote={quote}
                onClearQuote={() => setQuote(null)}
              />
              <div
                style={{
                  textAlign: "center",
                  color: "var(--muted)",
                  fontSize: 12,
                  marginTop: 8,
                }}
              >
                Штурман читає документи інструментами та посилається на джерело. Enter — надіслати.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const STARTERS: { text: string; icon: React.ReactNode }[] = [
  { text: "Звірити інвойс із контрактом", icon: <IconFile size={15} /> },
  { text: "Перевірити комплектність пакета", icon: <IconCheck size={15} /> },
  { text: "Підказати код УКТ ЗЕД", icon: <IconSearch size={15} /> },
  { text: "Яких документів ще бракує?", icon: <IconFolder size={15} /> },
];

function Notice({ text, onClear }: { text: string; onClear: () => void }) {
  return (
    <div
      role="alert"
      onClick={onClear}
      style={{
        marginBottom: 8,
        padding: "8px 12px",
        borderRadius: 10,
        background: "var(--errBg)",
        color: "var(--err)",
        fontSize: 13,
        cursor: "pointer",
      }}
    >
      {text}
    </div>
  );
}

function Composer({
  input,
  setInput,
  inputRef,
  onPaste,
  onSend,
  onAttach,
  streaming,
  chatKind,
  onChangeKind,
  selector,
  placeholder,
  pending,
  onRemovePending,
  quote,
  onClearQuote,
}: {
  input: string;
  setInput: (v: string) => void;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  onPaste: (e: React.ClipboardEvent) => void;
  onSend: () => void;
  onAttach?: () => void;
  streaming: boolean;
  chatKind: ChatKind;
  onChangeKind: (k: ChatKind) => void;
  selector?: EntitySelector | null;
  placeholder?: string;
  pending: File[];
  onRemovePending: (f: File) => void;
  quote: string | null;
  onClearQuote: () => void;
}) {
  return (
    <div
      className="composer"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border2)",
        borderRadius: 16,
        boxShadow: "var(--shadow)",
      }}
    >
      {/* Top row: kind pills (Звичайний/Постачання/Збірний) + entity selector. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", gap: 2, padding: 2, background: "var(--hover)", borderRadius: 9 }}>
          {CHAT_TYPES.map((t) => {
            const on = chatKind === t.id;
            return (
              <button
                key={t.id}
                onClick={() => onChangeKind(t.id)}
                data-testid={`composer-kind-${t.id}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  height: 27,
                  padding: "0 12px",
                  border: "none",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: on ? 600 : 500,
                  background: on ? "var(--accent)" : "transparent",
                  color: on ? "var(--accentTx)" : "var(--muted)",
                  transition: "background .12s",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {selector && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", minWidth: 0 }}>
            <span style={{ fontSize: 11.5, color: "var(--faint)", whiteSpace: "nowrap" }}>
              {selector.label}:
            </span>
            <div style={{ position: "relative", minWidth: 0 }}>
              <select
                value={selector.value}
                onChange={(e) => selector.onChange(e.target.value)}
                data-testid="composer-entity-select"
                style={{
                  maxWidth: 230,
                  height: 28,
                  padding: "0 26px 0 10px",
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--text)",
                  outline: "none",
                  cursor: "pointer",
                  appearance: "none",
                  WebkitAppearance: "none",
                  textOverflow: "ellipsis",
                }}
              >
                {selector.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span
                style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  pointerEvents: "none",
                  color: "var(--muted)",
                  display: "flex",
                }}
              >
                <LnChevronDown size={14} />
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Staged files: chips shown ABOVE the input; uploaded only on send. */}
      {pending.length > 0 && (
        <div
          data-testid="composer-pending"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: "8px 10px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {pending.map((f) => (
            <span
              key={fileKey(f)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 28,
                padding: "0 4px 0 9px",
                background: "var(--hover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--text)",
                maxWidth: 220,
              }}
            >
              <span style={{ color: "var(--accent)", display: "flex", flex: "none" }}>
                <IconFile size={13} />
              </span>
              <span className="ellipsis" style={{ maxWidth: 150 }}>
                {f.name}
              </span>
              <button
                onClick={() => onRemovePending(f)}
                disabled={streaming}
                aria-label="Прибрати файл"
                title="Прибрати"
                style={{
                  flex: "none",
                  width: 20,
                  height: 20,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "none",
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--muted)",
                  cursor: streaming ? "default" : "pointer",
                  fontSize: 15,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Quoted fragment (highlight-to-ask): shown above the input; sent as context. */}
      {quote && (
        <div
          data-testid="composer-quote"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "8px 10px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span
            style={{
              flex: "none",
              alignSelf: "stretch",
              width: 3,
              borderRadius: 2,
              background: "var(--accent)",
            }}
          />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              lineHeight: 1.4,
              color: "var(--muted)",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
            title={quote}
          >
            {quote}
          </span>
          <button
            onClick={onClearQuote}
            aria-label="Прибрати цитату"
            title="Прибрати"
            style={{
              flex: "none",
              width: 20,
              height: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: "var(--muted)",
              cursor: "pointer",
              fontSize: 15,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Bottom row: attach / textarea (Enter-send, Shift+Enter-newline) / send. */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, padding: "8px 8px 8px 15px" }}>
        {onAttach && (
          <button
            title="Долучити файл"
            aria-label="Долучити файл"
            data-testid="chat-attach"
            onClick={onAttach}
            disabled={streaming}
            style={{
              flex: "none",
              width: 40,
              height: 40,
              alignSelf: "center",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              border: "none",
              background: "transparent",
              color: "var(--muted)",
              cursor: streaming ? "default" : "pointer",
            }}
          >
            <IconAttach size={21} />
          </button>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={
            quote
              ? "Спитайте про виділений фрагмент…"
              : placeholder ?? "Спитайте Штурмана або перетягніть / вставте файли"
          }
          data-testid="chat-input"
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--text)",
            font: "inherit",
            maxHeight: 160,
            padding: "8px 4px",
          }}
        />
        <button
          className="btn btn-primary"
          onClick={onSend}
          disabled={streaming || (!input.trim() && pending.length === 0 && !quote)}
          style={{ height: 40, width: 40, padding: 0, borderRadius: 11 }}
          aria-label="Надіслати"
        >
          {streaming ? <IconSpinner size={16} /> : <IconSend size={16} />}
        </button>
      </div>
    </div>
  );
}

function DateSeparator() {
  const d = new Date();
  const label = d.toLocaleDateString("uk-UA", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return (
    <div
      style={{
        textAlign: "center",
        color: "var(--muted)",
        fontSize: 12,
        letterSpacing: 1,
        margin: "0 0 20px",
      }}
    >
      — — — СЬОГОДНІ · {label} — — —
    </div>
  );
}

function AgentAvatar() {
  return (
    <span
      style={{
        flex: "none",
        width: 32,
        height: 32,
        borderRadius: 9,
        background: "var(--accent)",
        color: "var(--accentTx)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: 13,
        marginTop: 2,
      }}
    >
      Ш
    </span>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", margin: "14px 0 26px" }}>
      <div
        style={{
          background: "var(--bubble)",
          color: "var(--bubbleTx)",
          padding: "12px 17px",
          borderRadius: "20px 20px 6px 20px",
          maxWidth: "78%",
          whiteSpace: "pre-wrap",
          fontSize: 15,
          lineHeight: 1.55,
        }}
      >
        {text}
      </div>
    </div>
  );
}

function ClassifyBubble({
  card,
  folders,
  onPick,
}: {
  card: ClassifyCard;
  folders: Folder[];
  onPick: (card: ClassifyCard, folder: Folder) => void;
}) {
  const busy =
    card.state === "uploading" ||
    card.state === "classifying" ||
    card.state === "moving";

  const statusText =
    card.state === "uploading"
      ? "Завантажую…"
      : card.state === "classifying"
      ? "Класифікую…"
      : card.state === "moving"
      ? "Переміщую…"
      : card.state === "error"
      ? "Не вдалося завантажити."
      : card.state === "filed"
      ? `Віднесено до «${folderLabel(card.folderName ?? "")}».`
      : "Не вдалося визначити папку — оберіть вручну:";

  return (
    <div style={{ margin: "18px 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            background: "var(--accent)",
            color: "var(--accentTx)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <IconFile size={15} />
        </span>
        <span style={{ fontWeight: 600 }} className="ellipsis">
          {card.name}
        </span>
      </div>
      <div
        style={{
          paddingLeft: 34,
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: card.state === "error" ? "var(--err)" : "var(--muted)",
          fontSize: 14,
        }}
      >
        {busy ? (
          <IconSpinner size={14} />
        ) : card.state === "filed" ? (
          <IconCheck size={14} />
        ) : null}
        <span>{statusText}</span>
      </div>
      {card.state === "needs_pick" && (
        <div
          style={{
            paddingLeft: 34,
            marginTop: 10,
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          {folders.map((folder) => (
            <button
              key={folder.id}
              className="btn"
              style={{ height: 30, padding: "0 12px", fontSize: 13 }}
              onClick={() => onPick(card, folder)}
            >
              <IconFolder size={14} /> {folderLabel(folder.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantBubble({
  text,
  citations,
  pending,
}: {
  text: string;
  citations?: Citation[];
  pending?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 14, margin: "18px 0 28px" }} data-anim>
      <AgentAvatar />
      {/* data-role marks the selectable answer region for highlight-to-ask. */}
      <div style={{ flex: 1, minWidth: 0 }} data-role="assistant">
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
          Штурман
        </div>
        {pending ? (
          <span style={{ color: "var(--muted)" }}>
            <IconSpinner size={16} /> Обмірковує…
          </span>
        ) : (
          <Markdown>{text}</Markdown>
        )}
        {citations && citations.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
            {citations.map((c, i) => (
              <span
                key={i}
                className="badge"
                style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}
                title={c.page != null ? `Стор. ${c.page}` : undefined}
              >
                {c.file}
                {c.page != null ? ` · с.${c.page}` : ""}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
