"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Citation, Folder, Message } from "@/lib/types";
import { streamChat } from "@/lib/sse";
import { Markdown } from "./Markdown";
import type { LogEntry } from "./AgentLog";
import {
  IconAgent,
  IconSend,
  IconAttach,
  IconSpinner,
  IconFile,
  IconFolder,
  IconCheck,
} from "./icons";

const UPLOAD_ACCEPT = ".pdf,.docx,.xlsx,.csv,.png,.jpg,.jpeg";

export interface UploadClassifyOutcome {
  fileId: string;
  name: string;
  folderName: string | null;
}

interface Props {
  workspaceId: string;
  conversationId?: string;
  initialMessages: Message[];
  onConversationStarted: (id: string) => void;
  onLog: (entry: LogEntry) => void;
  folders: Folder[];
  onUploadAndClassify: (files: FileList) => Promise<UploadClassifyOutcome[]>;
  onMoveFile: (fileId: string, folderId: string) => Promise<void>;
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
  workspaceId,
  conversationId,
  initialMessages,
  onConversationStarted,
  onLog,
  folders,
  onUploadAndClassify,
  onMoveFile,
}: Props) {
  const [items, setItems] = useState<ChatItem[]>(() =>
    initialMessages.map((m) => ({ kind: "message" as const, ...m }))
  );
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const convRef = useRef<string | undefined>(conversationId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamTextRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setItems(initialMessages.map((m) => ({ kind: "message" as const, ...m })));
    convRef.current = conversationId;
  }, [initialMessages, conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, streaming]);

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
    async (fileList: FileList) => {
      // One card per selected file, in order, starting at "uploading".
      const names = Array.from(fileList).map((f) => f.name);
      const cards: ClassifyCard[] = names.map((name) => ({
        kind: "classify",
        id: `card-${cardSeq++}`,
        fileId: null,
        name,
        state: "uploading",
      }));
      setItems((list) => [...list, ...cards]);

      const outcomes = await onUploadAndClassify(fileList);

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

  const pickFolder = useCallback(
    async (card: ClassifyCard, folder: Folder) => {
      if (!card.fileId) return;
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

  const send = useCallback(async () => {
    const text = input.trim();
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
        workspaceId,
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
  }, [input, streaming, workspaceId, onConversationStarted, onLog]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--chat)",
      }}
    >
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "24px 0" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 24px" }}>
          <DateSeparator />
          {items.map((it) =>
            it.kind === "classify" ? (
              <ClassifyBubble
                key={it.id}
                card={it}
                folders={folders}
                onPick={pickFolder}
              />
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

      <div style={{ flex: "none", padding: "0 24px 18px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div
            className="panel"
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 8,
              padding: 8,
              background: "var(--surface)",
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept={UPLOAD_ACCEPT}
              onChange={(e) => {
                if (e.target.files && e.target.files.length)
                  void handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              className="btn-icon"
              title="Долучити файл"
              aria-label="Долучити файл"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming}
            >
              <IconAttach size={18} />
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Спитайте Штурмана"
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
              onClick={send}
              disabled={streaming || !input.trim()}
              style={{ height: 36, width: 36, padding: 0, borderRadius: 999 }}
              aria-label="Надіслати"
            >
              {streaming ? <IconSpinner size={16} /> : <IconSend size={16} />}
            </button>
          </div>
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

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", margin: "14px 0" }}>
      <div
        style={{
          background: "var(--bubble)",
          color: "var(--bubbleTx)",
          padding: "12px 16px",
          borderRadius: 16,
          borderBottomRightRadius: 6,
          maxWidth: "78%",
          whiteSpace: "pre-wrap",
          fontSize: 15,
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
      ? `Віднесено до «${card.folderName}».`
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
              <IconFolder size={14} /> {folder.name}
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
          <IconAgent size={16} />
        </span>
        <span style={{ fontWeight: 600 }}>Штурман</span>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>агент</span>
      </div>
      <div style={{ paddingLeft: 34 }}>
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
