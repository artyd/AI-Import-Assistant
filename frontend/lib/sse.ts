// SSE helpers.
//
// Chat is SSE-over-POST → we use fetch + a ReadableStream reader (EventSource
// can't POST or set the Authorization header). The live file-status channel is
// SSE-over-GET → the native EventSource works with a relative URL and a
// ?access_token= query param (browsers can't set headers on EventSource).

import { getToken } from "./api";
import type {
  DoneEvent,
  ErrorEvent as StreamErrorEvent,
  TokenEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "./types";

export interface ChatHandlers {
  onToken?: (e: TokenEvent) => void;
  onToolCall?: (e: ToolCallEvent) => void;
  onToolResult?: (e: ToolResultEvent) => void;
  onDone?: (e: DoneEvent) => void;
  onError?: (e: StreamErrorEvent) => void;
}

/**
 * POST a chat message and dispatch the SSE stream to handlers.
 * Resolves when the stream ends. Abort via `signal`.
 */
export async function streamChat(
  workspaceId: string,
  payload: { message: string; conversationId?: string },
  handlers: ChatHandlers,
  signal?: AbortSignal
): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api/workspaces/${workspaceId}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = `Помилка ${res.status}`;
    try {
      const j = await res.json();
      message = j?.error || j?.message || message;
    } catch {
      /* ignore */
    }
    handlers.onError?.({ message });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (rawEvent: string) => {
    // One SSE record: lines of `event:` / `data:` (ignore `:` comments/pings).
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith(":")) continue; // keep-alive ping
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    switch (eventName) {
      case "token":
        handlers.onToken?.(data as TokenEvent);
        break;
      case "tool_call":
        handlers.onToolCall?.(data as ToolCallEvent);
        break;
      case "tool_result":
        handlers.onToolResult?.(data as ToolResultEvent);
        break;
      case "done":
        handlers.onDone?.(data as DoneEvent);
        break;
      case "error":
        handlers.onError?.(data as StreamErrorEvent);
        break;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE records are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      dispatch(rawEvent);
    }
  }
  // Flush any trailing record.
  if (buffer.trim()) dispatch(buffer);
}

/** Open the live file-status EventSource (SSE-over-GET, token in query). */
export function openEventsChannel(
  workspaceId: string,
  onFileStatus: (data: unknown) => void,
  onError?: () => void
): EventSource {
  const token = getToken() ?? "";
  const es = new EventSource(
    `/api/workspaces/${workspaceId}/events?access_token=${encodeURIComponent(token)}`
  );
  es.addEventListener("file_status", (ev) => {
    try {
      onFileStatus(JSON.parse((ev as MessageEvent).data));
    } catch {
      /* ignore malformed */
    }
  });
  if (onError) es.addEventListener("error", () => onError());
  return es;
}
