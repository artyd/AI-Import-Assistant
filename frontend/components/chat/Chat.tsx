"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatKind, ChatUsage, DocsStatus, Folder, Message } from "@/lib/types";
import { ContextMeters } from "./ContextMeters";
import { runTurn, turnContent } from "@/lib/chat/turn";
import { Notice } from "../ui/Notice";
import {
  type SurveyAnswers,
  type SurveyIntakeField,
  type SurveyOption,
  type SurveyQuestion,
  type SurveyStatus,
} from "@/lib/surveyQuestions";
import type { LogEntry } from "./AgentLog";
import { IconAttach, IconFile, IconFolder, IconCheck, IconSearch } from "../ui/icons";
import { UPLOAD_ACCEPT, fileKey, acceptFiles } from "@/lib/files/policy";
import { type ClassifyCard, type QuestionCard, DateSeparator, UserBubble, ClassifyBubble, QuestionBubble, AssistantBubble } from "./bubbles";
import { type EntitySelector, Composer } from "./Composer";
import { activeQuestions, answersRecord, intakePatch, surveyMessage, withAnswer, type SurveyAnswer } from "@/lib/chat/survey";
export type { EntitySelector } from "./Composer";
export { CHAT_TYPES } from "./Composer";

export interface UploadClassifyOutcome {
  fileId: string;
  name: string;
  folderName: string | null;
}

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
  /** Shipment documents' processing state, for the «Документи» meter (supply chat). */
  docsStatus?: DocsStatus | null;
  // Shipment survey (supply only). When provided, the "Опитування" button shows
  // and survey state is persisted so it survives reloads. initialSurvey* seed a
  // resume: the survey restarts at the first still-unanswered question.
  onSurveyPersist?: (state: { answers?: SurveyAnswers; status: SurveyStatus }) => void;
  initialSurveyStatus?: SurveyStatus | null;
  initialSurveyAnswers?: SurveyAnswers | null;
  // Deterministic survey → intake: writes contract_type/transport_mode/product_category
  // straight to the workspace so the sidebar updates immediately (not via the agent).
  onSurveyIntake?: (patch: Partial<Record<SurveyIntakeField, string>>) => void;
  // Which intake fields are already filled (autopilot) — those questions are skipped.
  surveyPrefilled?: Partial<Record<SurveyIntakeField, boolean>>;
}

type ChatItem = ({ kind: "message" } & Message) | ClassifyCard | QuestionCard;

// Typed command that starts the survey (supply chat only). A dedicated button
// lands in Phase 5; a typed command works today.
const SURVEY_TRIGGER_RX =
  /^\/?(опитування|опрос|survey|почни опитування|пройти опитування|start survey)$/i;

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
  if (tool === "find_files")
    return `Шукаю файли: «${String(input.query ?? "")}»`;
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
  docsStatus,
  onSurveyPersist,
  onSurveyIntake,
  surveyPrefilled,
}: Props) {
  // File intake is only wired when the host supplies the workspace file handlers.
  const fileIntake = !!(onUploadAndClassify && onMoveFile && folders);
  const [items, setItems] = useState<ChatItem[]>(() =>
    initialMessages.map((m) => ({ kind: "message" as const, ...m }))
  );
  // NB: the composer's text lives inside <Composer> (F5) so typing re-renders
  // only the composer, never the message list.
  const [streaming, setStreaming] = useState(false);
  // Context / chat-window usage of the latest reply (meters under the input).
  const [usage, setUsage] = useState<ChatUsage | null>(() => lastUsage(initialMessages));
  // The in-flight chat stream; aborted on stop / unmount / conversation or
  // endpoint (workspace, collection) change.
  const abortRef = useRef<AbortController | null>(null);
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
    // Another conversation was loaded → stop streaming into the old thread.
    abortRef.current?.abort();
    setItems(initialMessages.map((m) => ({ kind: "message" as const, ...m })));
    setUsage(lastUsage(initialMessages));
    convRef.current = conversationId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessages]);

  // Abort the in-flight stream on unmount and when the chat endpoint changes
  // (switching shipment / collection keeps this component mounted).
  useEffect(() => () => abortRef.current?.abort(), [postPath]);

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

      // Match outcomes back to cards by name (a file skipped client-side — too
      // large — or rejected by the server has no outcome, which would shift a
      // positional match); fall back to position only when nothing was dropped.
      const used = new Set<string>();
      cards.forEach((card, i) => {
        const outcome =
          outcomes.find((o) => o.name === card.name && !used.has(o.fileId)) ??
          (outcomes.length === cards.length && outcomes[i] && !used.has(outcomes[i]!.fileId)
            ? outcomes[i]
            : undefined);
        if (outcome) used.add(outcome.fileId);
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
    setStreaming(true);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

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
      await runTurn(
        postPath,
        { message: text, conversationId: convRef.current },
        {
          onUpdate: (t) =>
            updateAssistant(
              t.phase === "done" && t.done
                ? { id: t.done.messageId || assistantId, content: turnContent(t), citations: t.done.citations }
                : { content: turnContent(t) }
            ),
          onToolCall: (e) =>
            onLog({ id: `l${logSeq++}`, time: hhmm(), text: labelToolCall(e.tool, e.input), kind: "call" }),
          onToolResult: (e) => onLog({ id: `l${logSeq++}`, time: hhmm(), text: e.summary, kind: "result" }),
          onDone: (e) => {
            if (e.usage) setUsage(e.usage);
            if (e.conversationId && convRef.current !== e.conversationId) {
              convRef.current = e.conversationId;
              onConversationStarted(e.conversationId);
            }
            onTurnComplete?.();
          },
        },
        ctrl.signal
      );
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setStreaming(false);
    }
  }, [streaming, postPath, onConversationStarted, onLog, onTurnComplete]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // ── Shipment survey (client-driven question cards) ──────────────────────────
  // Answers are collected locally and submitted as ONE chat message at the end,
  // so the agent persists everything in a single turn (cheaper than a turn per
  // question) while still honouring "answer = normal chat message". State (answers
  // + status) is also persisted to the workspace via onSurveyPersist for resume.
  const surveyAnswersRef = useRef<SurveyAnswer[]>([]);
  // The active (filtered) question list for the current run — questions whose
  // intake field is already filled (autopilot) are skipped.
  const activeQuestionsRef = useRef<SurveyQuestion[]>([]);

  const submitSurvey = useCallback(() => {
    const answers = surveyAnswersRef.current;
    if (answers.length === 0) return;
    const record = answersRecord(answers);
    const patch = intakePatch(answers);
    const msg = surveyMessage(answers);
    surveyAnswersRef.current = [];
    activeQuestionsRef.current = [];
    // Deterministic sidebar update (does not wait for the agent).
    if (Object.keys(patch).length > 0) onSurveyIntake?.(patch);
    onSurveyPersist?.({ answers: record, status: "completed" });
    void runMessage(msg);
  }, [runMessage, onSurveyPersist, onSurveyIntake]);

  const startSurvey = useCallback(() => {
    if (streaming) return;
    // Skip questions whose intake field is already filled (autopilot).
    const active = activeQuestions(surveyPrefilled);
    activeQuestionsRef.current = active;
    surveyAnswersRef.current = [];
    const first = active[0];
    if (!first) return; // nothing left to ask
    setItems((m) => [
      ...m,
      { kind: "question", id: `q-${Date.now()}-0`, q: first, index: 1, total: active.length, answered: false },
    ]);
    onSurveyPersist?.({ status: "in_progress" });
  }, [streaming, surveyPrefilled, onSurveyPersist]);

  const answerQuestion = useCallback(
    (card: QuestionCard, answer: SurveyOption) => {
      surveyAnswersRef.current = withAnswer(surveyAnswersRef.current, {
        id: card.q.id,
        question: card.q.question,
        label: answer.label,
        value: answer.value,
        q: card.q,
      });
      const active = activeQuestionsRef.current;
      const nextQ = active[card.index]; // index is 1-based → next lives at [index]
      setItems((m) => {
        const marked = m.map((it) =>
          it.kind === "question" && it.id === card.id
            ? { ...it, answered: true, answerLabel: answer.label }
            : it
        );
        return nextQ
          ? [
              ...marked,
              {
                kind: "question" as const,
                id: `q-${Date.now()}-${card.index}`,
                q: nextQ,
                index: card.index + 1,
                total: active.length,
                answered: false,
              },
            ]
          : marked;
      });
      if (!nextQ) submitSurvey();
      else onSurveyPersist?.({ answers: answersRecord(surveyAnswersRef.current), status: "in_progress" });
    },
    [submitSurvey, onSurveyPersist]
  );

  const skipSurvey = useCallback(
    (card: QuestionCard) => {
      surveyAnswersRef.current = [];
      activeQuestionsRef.current = [];
      setItems((m) =>
        m.map((it) =>
          it.kind === "question" && it.id === card.id
            ? { ...it, answered: true, answerLabel: "— опитування пропущено —" }
            : it
        )
      );
      onSurveyPersist?.({ status: "skipped" });
    },
    [onSurveyPersist]
  );

  // On send: first upload + classify any staged files (they show as classify
  // cards in the thread, exactly like the old inline flow), then stream the text
  // message if there is one. Sending is allowed with files only, text only, or both.
  // Returns whether the composer's text was consumed (→ the composer clears it).
  const send = useCallback((raw: string): boolean => {
    if (streaming) return false;
    const text = raw.trim();
    const files = pending;
    const q = quote;
    if (!text && files.length === 0 && !q) return false;

    // Client-driven survey: a typed command starts it (supply chat only). A
    // dedicated button lands in Phase 5.
    if (chatKind === "supply" && !q && files.length === 0 && SURVEY_TRIGGER_RX.test(text)) {
      startSurvey();
      return true;
    }

    // Consolidated: a pasted Google Sheets link runs the analysis DIRECTLY (exact
    // per-product blocks), not through the agent (which would reformat it).
    if (onAnalyzeManifest && !q && files.length === 0) {
      const m = text.match(/https?:\/\/docs\.google\.com\/spreadsheets\/\S+/i);
      if (m) {
        onAnalyzeManifest({ url: m[0] });
        return true;
      }
    }
    void (async () => {
      if (files.length) {
        setPending([]);
        await handleFiles(files);
      }
      if (text || q) {
        // When a fragment is quoted, prepend it as context so the agent answers
        // about that exact excerpt. A quote with no question ⇒ "explain it".
        const composed = q
          ? `Стосовно цього фрагмента попередньої відповіді:\n«${q}»\n\n${text || "Поясни детальніше."}`
          : raw;
        if (q) setQuote(null);
        await runMessage(composed);
      }
    })();
    return true;
  }, [streaming, pending, quote, handleFiles, runMessage, onAnalyzeManifest, chatKind, startSurvey]);

  const clearQuote = useCallback(() => setQuote(null), []);
  const clearNotice = useCallback(() => setNotice(null), []);

  // Which action the composer paperclip performs: manifest analyse (consolidated)
  // or the supply auto-file staging flow.
  const openManifestPicker = useCallback(() => manifestInputRef.current?.click(), []);
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);
  const attachAction = onAnalyzeManifest
    ? openManifestPicker
    : fileIntake
      ? openFilePicker
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
            {notice && <Notice text={notice} onClear={clearNotice} />}
            <Composer
              inputRef={inputRef}
              onPaste={onPaste}
              onSend={send}
              onStop={stop}
              onAttach={attachAction}
              onStartSurvey={chatKind === "supply" ? startSurvey : undefined}
              streaming={streaming}
              chatKind={chatKind}
              onChangeKind={onChangeKind}
              selector={selector}
              placeholder={placeholder}
              pending={pending}
              onRemovePending={removePending}
              quote={quote}
              onClearQuote={clearQuote}
            />
            <ContextMeters usage={null} streaming={streaming} docs={docsStatus} docsOnly />
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
                  <ClassifyBubble key={it.id} card={it} folders={folders ?? NO_FOLDERS} onPick={pickFolder} />
                ) : it.kind === "question" ? (
                  <QuestionBubble key={it.id} card={it} onAnswer={answerQuestion} onSkip={skipSurvey} />
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
              {notice && <Notice text={notice} onClear={clearNotice} />}
              <Composer
                inputRef={inputRef}
                onPaste={onPaste}
                onSend={send}
                onStop={stop}
                onAttach={attachAction}
                onStartSurvey={chatKind === "supply" ? startSurvey : undefined}
                streaming={streaming}
                chatKind={chatKind}
                onChangeKind={onChangeKind}
                selector={selector}
                placeholder={placeholder}
                pending={pending}
                onRemovePending={removePending}
                quote={quote}
                onClearQuote={clearQuote}
              />
              <ContextMeters usage={usage} streaming={streaming} docs={docsStatus} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Usage of the newest assistant message that carries one (older turns have none). */
function lastUsage(messages: Message[]): ChatUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i]!.usage;
    if (messages[i]!.role === "assistant" && u) return u;
  }
  return null;
}

const STARTERS: { text: string; icon: React.ReactNode }[] = [
  { text: "Звірити інвойс із контрактом", icon: <IconFile size={15} /> },
  { text: "Перевірити комплектність пакета", icon: <IconCheck size={15} /> },
  { text: "Підказати код УКТ ЗЕД", icon: <IconSearch size={15} /> },
  { text: "Яких документів ще бракує?", icon: <IconFolder size={15} /> },
];

const NO_FOLDERS: Folder[] = [];
