"use client";
import { memo, useState } from "react";
import type { Folder, Citation } from "@/lib/types";
import { folderLabel } from "@/lib/folderLabels";
import { type SurveyQuestion, type SurveyOption } from "@/lib/surveyQuestions";
import { Markdown } from "../ui/Markdown";
import { IconFile, IconSpinner, IconCheck, IconFolder } from "../ui/icons";

// Local-only chat items for the paperclip flow. These are NOT persisted to the
// conversation (they don't go through the agent/SSE); on reload they vanish, but
// the file's final folder is reflected in the file tree, so no data is lost.
type ClassifyCardState =
  | "uploading"
  | "classifying"
  | "filed"
  | "needs_pick"
  /** Uploaded; Штурман files it after reading it (spec 007). */
  | "deferred"
  | "moving"
  | "error";

export interface ClassifyCard {
  kind: "classify";
  id: string;
  fileId: string | null;
  name: string;
  state: ClassifyCardState;
  folderName?: string;
}

// A single survey question rendered as an interactive card in the thread. Local
// only (like ClassifyCard) — the collected answers are submitted to the agent as
// one normal chat message when the survey completes; on reload the cards vanish
// but the agent-persisted context remains.
export interface QuestionCard {
  kind: "question";
  id: string;
  q: SurveyQuestion; // the resolved question (from the filtered active list)
  index: number; // 1-based position for display
  total: number;
  answered: boolean;
  answerLabel?: string; // chosen option label (or free text) once answered
}

export function DateSeparator() {
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

// Bubbles are memoised on primitive/stable props: while a reply streams only
// the last (assistant) item gets a new object, so earlier messages skip render.
export const UserBubble = memo(function UserBubble({ text }: { text: string }) {
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
});

export function ClassifyBubble({
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
      : card.state === "deferred"
      ? "Прийнято. Штурман прочитає файл повністю й сам покладе його в потрібну папку — хід видно нижче і в Журналі."
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

export function QuestionBubble({
  card,
  onAnswer,
  onSkip,
}: {
  card: QuestionCard;
  onAnswer: (card: QuestionCard, answer: SurveyOption) => void;
  onSkip: (card: QuestionCard) => void;
}) {
  const q: SurveyQuestion = card.q;
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");

  const optBtn = { height: 30, padding: "0 12px", fontSize: 13 } as const;
  const submitOther = () => {
    const t = otherText.trim();
    if (t) onAnswer(card, { value: "other", label: t });
  };

  return (
    <div style={{ margin: "18px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            background: "var(--accent)",
            color: "var(--accentTx)",
            display: "grid",
            placeItems: "center",
            fontSize: 14,
          }}
        >
          ?
        </span>
        <span style={{ fontWeight: 600 }}>
          Опитування про постачання · Питання {card.index} з {card.total}
        </span>
      </div>
      <div style={{ paddingLeft: 34 }}>
        <div style={{ marginBottom: 10, lineHeight: 1.45 }}>{q.question}</div>
        {card.answered ? (
          <div
            style={{
              color: "var(--muted)",
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <IconCheck size={14} /> {card.answerLabel}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {q.options.map((o) => (
                <button key={o.value} className="btn" style={optBtn} onClick={() => onAnswer(card, o)}>
                  {o.label}
                </button>
              ))}
              {q.allowOther !== false && (
                <button className="btn" style={optBtn} onClick={() => setOtherOpen((v) => !v)}>
                  Інше…
                </button>
              )}
            </div>
            {otherOpen && (
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input
                  className="input"
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  placeholder="Ваш варіант…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitOther();
                    }
                  }}
                />
                <button className="btn" disabled={!otherText.trim()} onClick={submitOther}>
                  Надіслати
                </button>
              </div>
            )}
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                onClick={() => onSkip(card)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--muted)",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: 0,
                  textDecoration: "underline",
                }}
              >
                Пропустити опитування
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const AssistantBubble = memo(function AssistantBubble({
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
});
