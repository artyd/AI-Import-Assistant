import { streamChat } from "@/lib/sse";
import type { DoneEvent, ToolCallEvent, ToolResultEvent } from "@/lib/types";

/**
 * One assistant turn over the chat SSE contract (token · tool_call ·
 * tool_result · done · error), shared by every chat in the app. The turn is a
 * pure reducer over stream events; `runTurn` drives it from `streamChat`.
 */
export interface TurnState {
  /** Text streamed so far. */
  text: string;
  phase: "streaming" | "done" | "error" | "aborted" | "failed";
  /** Tool names called during the turn, in order. */
  tools: string[];
  done: DoneEvent | null;
  error: string | null;
}

export type TurnEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; tool: string }
  | { type: "done"; done: DoneEvent }
  | { type: "error"; message: string }
  /** The user stopped it (or the chat moved on). */
  | { type: "aborted" }
  /** The request itself failed (network). */
  | { type: "failed" };

export const initialTurn: TurnState = { text: "", phase: "streaming", tools: [], done: null, error: null };

export function turnReducer(s: TurnState, e: TurnEvent): TurnState {
  if (s.phase !== "streaming") return s; // terminal states are final
  switch (e.type) {
    case "token":
      return { ...s, text: s.text + e.text };
    case "tool_call":
      return { ...s, tools: [...s.tools, e.tool] };
    case "done":
      return { ...s, phase: "done", done: e.done };
    case "error":
      return { ...s, phase: "error", error: e.message };
    case "aborted":
      return { ...s, phase: "aborted" };
    case "failed":
      return { ...s, phase: "failed" };
  }
}

/** What the assistant bubble shows for the turn. */
export function turnContent(s: TurnState): string {
  const kept = s.text ? `${s.text}\n\n` : "";
  switch (s.phase) {
    case "streaming":
      return s.text;
    case "done":
      return s.done?.message || s.text;
    case "error":
      return `${kept}⚠️ ${s.error}`;
    case "aborted":
      return `${kept}⏹ Відповідь зупинено.`;
    case "failed":
      return "⚠️ Помилка з’єднання з сервером.";
  }
}

export interface TurnHandlers {
  /** Every state change (to re-render the bubble). */
  onUpdate: (s: TurnState) => void;
  onToolCall?: (e: ToolCallEvent) => void;
  onToolResult?: (e: ToolResultEvent) => void;
  /** The turn finished normally. */
  onDone?: (e: DoneEvent) => void;
}

/** Stream one turn; resolves with the final state (never throws). */
export async function runTurn(
  path: string,
  payload: { message: string; conversationId?: string },
  handlers: TurnHandlers,
  signal: AbortSignal,
): Promise<TurnState> {
  let s = initialTurn;
  const step = (e: TurnEvent) => {
    const next = turnReducer(s, e);
    if (next !== s) {
      s = next;
      handlers.onUpdate(s);
    }
  };
  try {
    await streamChat(
      path,
      payload,
      {
        onToken: (e) => step({ type: "token", text: e.text }),
        onToolCall: (e) => {
          step({ type: "tool_call", tool: e.tool });
          handlers.onToolCall?.(e);
        },
        onToolResult: (e) => handlers.onToolResult?.(e),
        onDone: (e) => {
          step({ type: "done", done: e });
          handlers.onDone?.(e);
        },
        onError: (e) => step({ type: "error", message: e.message }),
      },
      signal,
    );
    if (signal.aborted) step({ type: "aborted" });
  } catch {
    step(signal.aborted ? { type: "aborted" } : { type: "failed" });
  }
  return s;
}
