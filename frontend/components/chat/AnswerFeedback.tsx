"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { IconSpinner } from "../ui/icons";

/** A saved assistant message id (streaming / local placeholders can't be rated). */
export function isRateable(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** The chat message that asks Штурман for the corrected answer after a «Не так». */
export function correctionMessage(comment: string): string {
  return `Відповідь вище неправильна. Що не так: ${comment.trim()}. Перевір ще раз за документами й дай виправлену відповідь.`;
}

type State =
  | { kind: "idle" }
  | { kind: "up" }
  | { kind: "asking" }
  | { kind: "saving" }
  | { kind: "learned"; lesson: string | null }
  | { kind: "error"; text: string };

const Thumb = ({ down }: { down?: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={down ? { transform: "rotate(180deg)" } : undefined}>
    <path d="M7 10v11H3V10h4zM7 10l4-7a2.5 2.5 0 0 1 3 3l-1 4h5.5a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 17.1 21H7" />
  </svg>
);

/**
 * Rating that teaches Штурман. «Корисно» is recorded. «Не так» makes Штурман ask
 * what was wrong; the answer is saved, turned into a lesson the agent applies in
 * every later answer (POST /api/messages/:id/feedback — the lesson is stored
 * before it returns), and then the corrected answer is requested at once.
 */
export function AnswerFeedback({ messageId, onCorrect }: { messageId: string; onCorrect?: (comment: string) => void }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [comment, setComment] = useState("");

  const rate = async (rating: "up" | "down", text = "") => {
    return api<{ ok: true; lesson: { text: string } | null }>(`/api/messages/${messageId}/feedback`, {
      method: "POST",
      body: text ? { rating, comment: text } : { rating },
    });
  };

  const up = async () => {
    setState({ kind: "up" });
    await rate("up").catch(() => setState({ kind: "error", text: "Не вдалося зберегти оцінку." }));
  };

  const down = async () => {
    setState({ kind: "asking" });
    // The 👎 itself is recorded at once; the comment (and the lesson) follows.
    void rate("down").catch(() => undefined);
  };

  const submit = async () => {
    const text = comment.trim();
    if (text.length < 3) return;
    setState({ kind: "saving" });
    try {
      const r = await rate("down", text);
      setState({ kind: "learned", lesson: r.lesson?.text ?? null });
      onCorrect?.(text);
    } catch (e) {
      setState({ kind: "error", text: e instanceof ApiError ? e.message : "Не вдалося зберегти відгук." });
    }
  };

  if (state.kind === "up") return <div className="fb-note">Дякую — так і відповідатиму.</div>;
  if (state.kind === "error") return <div className="fb-note fb-err">{state.text}</div>;
  if (state.kind === "learned")
    return (
      <div className="fb-note">
        {state.lesson ? <>Запамʼятав на майбутнє: «{state.lesson}». </> : null}
        Перевіряю ще раз і даю виправлену відповідь нижче.
      </div>
    );

  if (state.kind === "asking" || state.kind === "saving")
    return (
      <div className="fb-ask" role="group" aria-label="Що не так у відповіді">
        <div className="fb-q">
          <b>Штурман:</b> Що не так у відповіді? Опишіть коротко — я перевірю ще раз за документами і запамʼятаю це на майбутнє.
        </div>
        <textarea
          className="fb-input"
          value={comment}
          autoFocus
          maxLength={2000}
          placeholder="Напр.: ти не перевірив ветсертифікат — товар кормовий; або: сума в інвойсі інша, 48 500 USD"
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
          }}
          disabled={state.kind === "saving"}
        />
        <div className="fb-actions">
          <button type="button" className="btn" onClick={() => setState({ kind: "idle" })} disabled={state.kind === "saving"}>
            Скасувати
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={state.kind === "saving" || comment.trim().length < 3}>
            {state.kind === "saving" ? <><IconSpinner size={14} /> Запамʼятовую…</> : "Надіслати й виправити"}
          </button>
        </div>
      </div>
    );

  return (
    <div className="fb-row">
      <button type="button" className="fb-btn" onClick={() => void up()} title="Корисна відповідь" aria-label="Корисна відповідь">
        <Thumb /> Корисно
      </button>
      <button type="button" className="fb-btn" onClick={() => void down()} title="Відповідь неправильна або неповна" aria-label="Відповідь неправильна">
        <Thumb down /> Не так
      </button>
    </div>
  );
}
