"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Citation, Message } from "@/lib/types";
import { streamChat } from "@/lib/sse";
import { Markdown } from "./Markdown";
import type { LogEntry } from "./AgentLog";
import { IconAgent, IconSend, IconAttach, IconSpinner } from "./icons";

interface Props {
  workspaceId: string;
  conversationId?: string;
  initialMessages: Message[];
  onConversationStarted: (id: string) => void;
  onLog: (entry: LogEntry) => void;
}

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
}: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const convRef = useRef<string | undefined>(conversationId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamTextRef = useRef("");

  useEffect(() => {
    setMessages(initialMessages);
    convRef.current = conversationId;
  }, [initialMessages, conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setStreaming(true);
    streamTextRef.current = "";

    const userMsg: Message = {
      id: `local-${Date.now()}`,
      role: "user",
      content: text,
    };
    const assistantId = `stream-${Date.now()}`;
    setMessages((m) => [
      ...m,
      userMsg,
      { id: assistantId, role: "assistant", content: "" },
    ]);

    const updateAssistant = (patch: Partial<Message>) =>
      setMessages((m) =>
        m.map((msg) => (msg.id === assistantId ? { ...msg, ...patch } : msg))
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
          {messages.map((m) =>
            m.role === "user" ? (
              <UserBubble key={m.id} text={m.content} />
            ) : (
              <AssistantBubble
                key={m.id}
                text={m.content}
                citations={m.citations}
                pending={streaming && m.content === ""}
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
            <button className="btn-icon" title="Долучити файл (через дерево)" disabled>
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
