"use client";
import { memo, useState } from "react";
import type { ChatKind } from "@/lib/types";
import { IconFile, IconAttach, IconSend } from "../ui/icons";
import { LnChevronDown } from "../ui/LineIcons";
import { fileKey } from "@/lib/files/policy";

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

// Memoised and owns its own text state: typing re-renders only the composer,
// and streaming tokens (which re-render <Chat>) skip it while its props hold.
export const Composer = memo(function Composer({
  inputRef,
  onPaste,
  onSend,
  onStop,
  onAttach,
  onStartSurvey,
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
  inputRef?: React.Ref<HTMLTextAreaElement>;
  onPaste: (e: React.ClipboardEvent) => void;
  // Returns true when the text was consumed (→ clear the input).
  onSend: (text: string) => boolean;
  onStop: () => void;
  onAttach?: () => void;
  onStartSurvey?: () => void;
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
  const [input, setInput] = useState("");
  const submit = () => {
    if (onSend(input)) setInput("");
  };
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
              submit();
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
        {streaming ? (
          // While a reply streams, the send slot becomes "Зупинити" (aborts it).
          <button
            className="btn btn-primary"
            onClick={onStop}
            data-testid="chat-stop"
            title="Зупинити відповідь"
            aria-label="Зупинити"
            style={{ height: 40, width: 40, padding: 0, borderRadius: 11 }}
          >
            <span
              aria-hidden
              style={{ width: 12, height: 12, borderRadius: 2, background: "currentColor" }}
            />
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={!input.trim() && pending.length === 0 && !quote}
            style={{ height: 40, width: 40, padding: 0, borderRadius: 11 }}
            aria-label="Надіслати"
          >
            <IconSend size={16} />
          </button>
        )}
        {onStartSurvey && (
          <button
            title="Опитування про постачання"
            aria-label="Опитування про постачання"
            data-testid="chat-survey"
            onClick={onStartSurvey}
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
              border: "1px solid var(--border2)",
              background: "transparent",
              color: "var(--muted)",
              fontSize: 18,
              fontWeight: 700,
              lineHeight: 1,
              cursor: streaming ? "default" : "pointer",
            }}
          >
            ?
          </button>
        )}
      </div>
    </div>
  );
});
