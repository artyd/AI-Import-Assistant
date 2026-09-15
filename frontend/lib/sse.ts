// SSE helpers.
//
// Chat is SSE-over-POST → we use fetch + a ReadableStream reader (EventSource
// can't POST or set the Authorization header). The live file-status channel is
// SSE-over-GET → the native EventSource works with a relative URL and a
// ?access_token= query param (browsers can't set headers on EventSource).

import { getToken } from "./api";
import type {
  AnalysisResult,
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
 * POST a chat message to `path` and dispatch the SSE stream to handlers.
 * `path` is the kind-specific chat endpoint (see `resolveChatEndpoints`):
 * `/api/workspaces/:id/chat`, `/api/chats`, or `/api/collections/:id/chat`.
 * All three speak the same event contract, so parsing below is identical.
 * Resolves when the stream ends. Abort via `signal`.
 */
export async function streamChat(
  path: string,
  payload: { message: string; conversationId?: string },
  handlers: ChatHandlers,
  signal?: AbortSignal
): Promise<void> {
  const token = getToken();
  const res = await fetch(path, {
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

export interface AnalyzeHandlers {
  onProgress?: (e: { pct: number; step: string }) => void;
  onDone?: (analysis: AnalysisResult) => void;
  onError?: (message: string) => void;
}

/**
 * POST a manifest (FormData with a file, or a JSON body { sheetUrl | text }) to
 * the consolidated-analysis endpoint and dispatch its SSE progress stream. Emits
 * `progress { pct, step }` while the engine runs, then `done { analysis }` or
 * `error { message }`. Same fetch+ReadableStream approach as streamChat (the
 * request can be multipart; the response is always text/event-stream).
 */
export async function streamAnalyze(
  path: string,
  body: Record<string, unknown> | FormData,
  handlers: AnalyzeHandlers,
  signal?: AbortSignal
): Promise<void> {
  const token = getToken();
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const res = await fetch(path, {
    method: "POST",
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "text/event-stream",
    },
    body: isForm ? (body as FormData) : JSON.stringify(body),
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
    handlers.onError?.(message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (rawEvent: string) => {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith(":")) continue;
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
    if (eventName === "progress") handlers.onProgress?.(data as { pct: number; step: string });
    else if (eventName === "done") handlers.onDone?.((data as { analysis: AnalysisResult }).analysis);
    else if (eventName === "error")
      handlers.onError?.((data as { message?: string }).message || "Помилка аналізу.");
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      dispatch(rawEvent);
    }
  }
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
