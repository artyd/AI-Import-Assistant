// Single API client. Every path is RELATIVE — the frontend and backend share
// one origin (the host's system Caddy routes /api/* to the backend), so there
// is no base URL and no NEXT_PUBLIC_API_URL. See DEPLOYMENT.md / API_CONTRACT.md.

const TOKEN_KEY = "aia_token";

/** Window event fired when the session expires (any 401 outside the login calls). */
export const AUTH_EXPIRED_EVENT = "auth:expired";

// Endpoints whose 401 means "wrong credentials", not "session expired".
const LOGIN_PATHS = new Set(["/api/auth/login", "/api/auth/login-code", "/api/auth/methods"]);

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

/**
 * Global 401 handling: a 401 from anything but the login endpoints means the
 * session is gone (expired/revoked JWT). Drop the token and tell the
 * AuthProvider, which clears the user → pages redirect to /login.
 */
export function handleUnauthorized(path: string, status: number): void {
  if (status !== 401 || typeof window === "undefined") return;
  const pathname = path.split("?")[0] ?? path;
  if (LOGIN_PATHS.has(pathname)) return;
  setToken(null);
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

/** Parse a body as JSON; a non-JSON body (e.g. a proxy's HTML 502 page) → undefined. */
function parseJson(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function toApiError(status: number, data: Record<string, unknown> | undefined): ApiError {
  const code = (data && typeof data.error === "string" && data.error) || `http_${status}`;
  const message = data && typeof data.message === "string" ? data.message : undefined;
  return new ApiError(status, code, message);
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  // For multipart uploads, pass a FormData as `form`.
  form?: FormData;
  signal?: AbortSignal;
}

/** JSON (or multipart) request against a relative /api path. */
export async function api<T = unknown>(
  path: string,
  opts: ApiOptions = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form; // browser sets multipart boundary
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(path, {
    method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"),
    headers,
    body,
    signal: opts.signal,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = parseJson(text);

  if (!res.ok) {
    handleUnauthorized(path, res.status);
    throw toApiError(res.status, data);
  }
  if (text && data === undefined) throw new ApiError(res.status, "invalid_response");
  return data as T;
}

/**
 * Multipart POST via XHR so the caller gets upload progress (fetch has no
 * upload-progress events). Same error semantics as `api()`.
 */
export function uploadWithProgress<T = unknown>(
  path: string,
  form: FormData,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    xhr.onload = () => {
      const data = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        if (xhr.responseText && data === undefined)
          reject(new ApiError(xhr.status, "invalid_response"));
        else resolve(data as T);
      } else {
        handleUnauthorized(path, xhr.status);
        reject(toApiError(xhr.status, data));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

/**
 * A short-lived (60 s), single-use ticket for opening an SSE EventSource via
 * `?ticket=` — so the JWT itself never lands in a URL / proxy log.
 */
export async function fetchSseTicket(): Promise<string> {
  const { ticket } = await api<{ ticket?: unknown }>("/api/auth/sse-ticket", { method: "POST" });
  if (typeof ticket !== "string" || !ticket) throw new ApiError(0, "invalid_ticket");
  return ticket;
}

/** Authenticated download of a binary response (e.g. the export zip). */
export async function downloadBlob(path: string, fallbackName: string): Promise<void> {
  const token = getToken();
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    handleUnauthorized(path, res.status);
    throw new ApiError(res.status, `http_${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  // Prefer the RFC 5987 UTF-8 name (Cyrillic shipment numbers), else the ASCII one.
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const m = /filename="?([^";]+)"?/.exec(cd);
  let name = fallbackName;
  try {
    name = utf ? decodeURIComponent(utf[1]!) : m?.[1] || fallbackName;
  } catch {
    name = m?.[1] || fallbackName;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
