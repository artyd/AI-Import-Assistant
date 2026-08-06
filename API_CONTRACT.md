# AI Import Assistant — Backend API Contract

This is the contract the (future) Next.js frontend implements. The provided
prototype is a static design mock with no wire calls, so this document — not the
prototype — is the source of truth for the HTTP/SSE shapes. Data shapes here
match exactly what the prototype UI renders.

- **Base URL:** the backend origin, injected on Vercel as `NEXT_PUBLIC_API_URL`
  (e.g. `https://api.ourdomain.com`). The browser calls this backend only; it
  never calls Anthropic/Voyage directly.
- **Auth:** `Authorization: Bearer <jwt>` on every request except
  `POST /api/auth/login`. For the two `EventSource` (SSE-over-GET) endpoints the
  browser cannot set headers, so pass `?access_token=<jwt>` instead (a `token`
  cookie is also accepted).
- **Content type:** JSON request/response, except file upload (multipart) and
  the SSE streams (`text/event-stream`).
- **Errors:** non-2xx responses are `{ "error": "<code>", ... }`. Common codes:
  `invalid_request`, `invalid_credentials`, `unauthorized`, `not_found`,
  `no_valid_files`, `rate_limit` (HTTP 429 from the chat limiter).

## Terminology

The brief's **workspace** is the prototype's **shipment** (`Постачання`). REST
paths use `/api/workspaces`; the entity carries `number`, `supplier`, `status`.

## File status mapping

Backend emits `queued | indexing | ready | error`. The prototype's status dot
uses `queued | indexing | done`, so the frontend maps **`ready → done`**
(«Готовий»). `error` should surface `errorReason`.

---

## Auth

### `POST /api/auth/login`
Request: `{ "email": string, "password": string }`
Response `200`: `{ "token": string, "user": { "id", "email", "name" } }`
Response `401`: `{ "error": "invalid_credentials" }`

### `POST /api/auth/logout`  (auth)
Response `200`: `{ "ok": true }` (JWT is stateless — client discards the token).

### `GET /api/auth/me`  (auth)
Response `200`: `{ "user": { "id", "email", "name" } }`

---

## Workspaces (shipments)

### `POST /api/workspaces`  (auth)
Request (all optional): `{ "number"?: string, "supplier"?: string, "status"?: "active"|"draft"|"done" }`
Creates the workspace **and** the 10-folder customs skeleton (`01_Contract … 10_Final`).
Response `201`: `{ "workspace": { "id","number","supplier","status","created_at" } }`

### `GET /api/workspaces`  (auth)
Response `200`: `{ "workspaces": [ { "id","number","supplier","status","created_at" } ] }`

### `GET /api/workspaces/:id`  (auth)
Response `200`:
```json
{
  "workspace": { "id","number","supplier","status","created_at" },
  "folders": [ { "id","name","position" } ]
}
```

---

## Files

### `POST /api/workspaces/:id/files?folderId=<uuid>`  (auth, multipart)
- `multipart/form-data` with one or more file parts. `folderId` (query) optional.
- Allow-list: `pdf, docx, xlsx, csv, png, jpg/jpeg`. Anything else (incl.
  executables) is rejected. Per-file size limit `MAX_UPLOAD_BYTES` (default 25 MB).
- On accept: stores to disk, writes a `queued` row, enqueues a background index
  job, and emits a `file_status` event (see the events channel).
Response `201`: `{ "files": [ { "id","name","type","status":"queued","folderId" } ], "rejected": [ { "name","reason" } ] }`
Response `415` when nothing valid was uploaded: `{ "error":"no_valid_files", "rejected":[…] }`

### `GET /api/workspaces/:id/files`  (auth)
Response `200`: `{ "files": [ { "id","folderId","name","type","status","errorReason","sizeBytes","createdAt" } ] }`

### `DELETE /api/workspaces/:id/files/:fileId`  (auth)
Deletes the disk file, its vector chunks, and the row; emits `file_status: deleted`.
Response `200`: `{ "ok": true }`

### Extensions (to support the tree UI)
- `POST /api/workspaces/:id/folders` — `{ "name": string }` → `201 { "folder": { "id","name","position" } }`
- `PATCH /api/workspaces/:id/files/:fileId` — `{ "name"?: string, "folderId"?: string|null }` → `200 { "file": {…} }`

---

## Chat (SSE)

### `POST /api/workspaces/:id/chat`  (auth, per-user rate-limited)
Request: `{ "message": string, "conversationId"?: string(uuid) }`
Omitting `conversationId` starts a new conversation.

Response: `Content-Type: text/event-stream`. The single agent ("Штурман") runs a
tool-use loop over three tools it chooses at runtime — `search_documents`
(semantic), `read_file` (precise), `list_files` — and streams:

| event | data | UI usage |
|-------|------|----------|
| `token` | `{ "text": string }` | append incremental assistant text |
| `tool_call` | `{ "tool": string, "input": object }` | "working" chip, e.g. `Reading: invoice.pdf`, `Searching…` |
| `tool_result` | `{ "tool": string, "summary": string }` | agent-log panel line (short summary, not raw data) |
| `done` | `{ "message": string, "citations": [ { "file": string, "page": number|null } ], "conversationId": string, "messageId": string }` | final message + clickable inline source chips |
| `error` | `{ "message": string }` | show error, stop the stream |

The stream also emits periodic `: ping` comments as keep-alives. `citations`
feeds the prototype's source chips; reconciliation diff-tables and completeness
checklists arrive as Markdown inside `message` (v1). Full conversation, tool
calls, and citations are persisted.

**Client note:** this is SSE over `POST`, so use `fetch` + a `ReadableStream`
reader (which can set the `Authorization` header), not the native `EventSource`.

---

## Conversations

### `GET /api/workspaces/:id/conversations`  (auth)
Response `200`: `{ "conversations": [ { "id","title","created_at","updated_at" } ] }`

### `GET /api/workspaces/:id/conversations/:convId`  (auth)
Response `200`:
```json
{
  "conversationId": "…",
  "messages": [
    { "id","role":"user"|"assistant","content","citations":[…],"tool_calls":[…],"created_at" }
  ]
}
```

---

## Live events channel (SSE)

### `GET /api/workspaces/:id/events`  (auth via `?access_token=`)
`Content-Type: text/event-stream`. Forwards real-time file indexing-status
transitions so the file-tree dots update without polling.

| event | data |
|-------|------|
| `file_status` | `{ "fileId": string, "status": "queued"|"indexing"|"ready"|"error"|"deleted", "name"?: string, "errorReason"?: string|null }` |

Consumable with the native `EventSource` (GET). Emits `: ping` keep-alives.

---

## Health

### `GET /health`  (no auth) → `{ "status": "ok" }`
