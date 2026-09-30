// SSE helpers.
//
// Chat is SSE-over-POST → we use fetch + a ReadableStream reader (EventSource
// can't POST or set the Authorization header). The live file-status channel is
// SSE-over-GET → the native EventSource with a relative URL and a short-lived,
// single-use `?ticket=` (fetched with the Bearer token right before every
// open/reconnect) — the JWT itself never goes into a URL.

import { fetchSseTicket, getToken, handleUnauthorized, ApiError } from "./api";
import type {
  AnalysisResult,
  DoneEvent,
  ErrorEvent as StreamErrorEvent,
  TokenEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "./types";

/** Shown when a stream ends without a `done` / `error` event. */
export const STREAM_INTERRUPTED_MESSAGE = "З’єднання перервано. Відповідь може бути неповною.";

const GENERIC_ERROR_MESSAGE = "Не вдалося обробити запит. Спробуйте ще раз.";

// Backend error codes → Ukrainian text (never show a raw code like `rate_limited`).
const ERROR_TEXT: Record<string, string> = {
  rate_limited: "Забагато запитів — зачекайте хвилину",
  rate_limit: "Забагато запитів — зачекайте хвилину",
  too_many_requests: "Забагато запитів — зачекайте хвилину",
  unauthorized: "Сесію завершено — увійдіть знову.",
  not_found: "Не знайдено.",
  invalid_request: "Некоректний запит.",
  missing_context: "Бракує даних постачання для цієї дії.",
};

/**
 * Turn a backend error (HTTP status + `error` code / message, or an SSE
 * `error` event message) into a user-facing Ukrainian message. A message that
 * is already human text in Ukrainian is kept as-is.
 */
export function friendlyError(status: number | null, codeOrMessage?: string | null): string {
  const raw = (codeOrMessage ?? "").trim();
  if (status === 429) return ERROR_TEXT.rate_limited!;
  if (status === 401) return ERROR_TEXT.unauthorized!;
  if (raw) {
    const mapped = ERROR_TEXT[raw.toLowerCase().replace(/[\s-]+/g, "_")];
    if (mapped) return mapped;
    // Already a human (Cyrillic) message from the backend → keep it.
    if (/[А-Яа-яЇїІіЄєҐґ]/.test(raw)) return raw;
  }
  return GENERIC_ERROR_MESSAGE;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === "AbortError"
    : !!err && typeof err === "object" && (err as { name?: string }).name === "AbortError";
}

/** Read the error body of a non-OK response into a Ukrainian message. */
async function responseError(path: string, res: Response): Promise<string> {
  handleUnauthorized(path, res.status);
  let code: string | undefined;
  try {
    const j = (await res.json()) as { error?: unknown; message?: unknown };
    // Prefer a Ukrainian `message`, else the `error` code.
    const msg = typeof j?.message === "string" ? j.message : undefined;
    const err = typeof j?.error === "string" ? j.error : undefined;
    code = msg && /[А-Яа-яЇїІіЄєҐґ]/.test(msg) ? msg : err ?? msg;
  } catch {
    /* non-JSON body (e.g. proxy HTML) */
  }
  return friendlyError(res.status, code);
}

/** Parse one SSE record (`event:` / `data:` lines; `:` comments are pings). */
function parseRecord(rawEvent: string): { event: string; data: unknown } | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith(":")) continue; // keep-alive ping
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event: eventName, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

/** Pump a text/event-stream body, calling `onRecord` for each record. */
async function pumpSse(
  body: ReadableStream<Uint8Array>,
  onRecord: (event: string, data: unknown) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (raw: string) => {
    const rec = parseRecord(raw.replace(/\r/g, ""));
    if (rec) onRecord(rec.event, rec.data);
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
      flush(rawEvent);
    }
  }
  // Flush any trailing record.
  if (buffer.trim()) flush(buffer);
}

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
 * Resolves when the stream ends. Abort via `signal` — an abort resolves
 * silently (no handler is called). A stream that ends without `done`/`error`
 * reports STREAM_INTERRUPTED_MESSAGE through `onError`.
 */
export async function streamChat(
  path: string,
  payload: { message: string; conversationId?: string },
  handlers: ChatHandlers,
  signal?: AbortSignal
): Promise<void> {
  const token = getToken();
  let terminal = false;
  try {
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
      const message = await responseError(path, res);
      handlers.onError?.({ message });
      return;
    }

    await pumpSse(res.body, (event, data) => {
      switch (event) {
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
          terminal = true;
          handlers.onDone?.(data as DoneEvent);
          break;
        case "error": {
          terminal = true;
          const e = data as { message?: string; code?: string };
          handlers.onError?.({ message: friendlyError(null, e?.code || e?.message) });
          break;
        }
      }
    });
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) return;
    throw err;
  }
  if (!terminal && !signal?.aborted) handlers.onError?.({ message: STREAM_INTERRUPTED_MESSAGE });
}

export interface AnalyzeDone {
  analysis: AnalysisResult;
  conversationId?: string;
  messageId?: string;
}

export interface AnalyzeHandlers {
  onProgress?: (e: { pct: number; step: string }) => void;
  onDone?: (done: AnalyzeDone) => void;
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
  let terminal = false;
  try {
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
      handlers.onError?.(await responseError(path, res));
      return;
    }

    await pumpSse(res.body, (event, data) => {
      if (event === "progress") handlers.onProgress?.(data as { pct: number; step: string });
      else if (event === "done") {
        terminal = true;
        handlers.onDone?.(data as AnalyzeDone);
      } else if (event === "error") {
        terminal = true;
        const e = data as { message?: string; code?: string };
        handlers.onError?.(
          e?.code || e?.message ? friendlyError(null, e.code || e.message) : "Помилка аналізу."
        );
      }
    });
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) return;
    throw err;
  }
  if (!terminal && !signal?.aborted) handlers.onError?.(STREAM_INTERRUPTED_MESSAGE);
}

export interface EventsChannel {
  close: () => void;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// A connection that stayed up at least this long resets the backoff.
const STABLE_MS = 30_000;

/**
 * Open the live file-status channel (SSE-over-GET) with reconnect.
 *
 * Every (re)open first fetches a fresh single-use ticket (`POST
 * /api/auth/sse-ticket`), then opens `/api/workspaces/:id/events?ticket=…`.
 * Tickets are single-use, so the browser's own EventSource auto-reconnect
 * (same URL) can't work: on any error we close and reconnect ourselves with
 * exponential backoff (1 s → 30 s). `onOpen` fires on every successful
 * (re)open so the caller can resync state that changed while disconnected.
 * A 401 on the ticket request ends the channel (api() has already signalled
 * the expired session).
 */
export function openEventsChannel(
  workspaceId: string,
  handlers: { onFileStatus: (data: unknown) => void; onOpen?: () => void }
): EventsChannel {
  let closed = false;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const schedule = () => {
    if (closed || timer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt);
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (closed) return;
    let ticket: string;
    try {
      ticket = await fetchSseTicket();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        closed = true; // session expired → AuthProvider redirects to /login
        return;
      }
      schedule();
      return;
    }
    if (closed) return;
    const source = new EventSource(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/events?ticket=${encodeURIComponent(ticket)}`
    );
    es = source;
    let openedAt = 0;
    source.addEventListener("open", () => {
      openedAt = Date.now();
      handlers.onOpen?.();
    });
    source.addEventListener("file_status", (ev) => {
      try {
        handlers.onFileStatus(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignore malformed */
      }
    });
    source.addEventListener("error", () => {
      // Never let the browser retry with the spent ticket.
      source.close();
      if (es === source) es = null;
      if (openedAt && Date.now() - openedAt >= STABLE_MS) attempt = 0;
      schedule();
    });
  };

  void connect();

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      es?.close();
      es = null;
    },
  };
}
