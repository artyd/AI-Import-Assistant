# AI Import Assistant — Backend API Contract

This is the contract the (future) Next.js frontend implements. The provided
prototype is a static design mock with no wire calls, so this document — not the
prototype — is the source of truth for the HTTP/SSE shapes. Data shapes here
match exactly what the prototype UI renders.

- **Base URL:** none — the frontend and backend share one origin (the system
  Caddy routes `/api/*` + `/health` to the backend and everything else to the
  Next.js app), so the browser uses **relative paths** (`fetch('/api/workspaces')`).
  It calls this backend only; it never calls Anthropic/Voyage directly.
- **Auth:** `Authorization: Bearer <jwt>` on every request except
  `POST /api/auth/login`. For the two `EventSource` (SSE-over-GET) endpoints the
  browser cannot set headers, so pass `?access_token=<jwt>` instead (a `token`
  cookie is also accepted).
- **Content type:** JSON request/response, except file upload (multipart) and
  the SSE streams (`text/event-stream`).
- **Errors:** non-2xx responses are `{ "error": "<code>", ... }`. Common codes:
  `invalid_request`, `invalid_credentials`, `unauthorized`, `not_found`,
  `no_valid_files`, `rate_limit` (HTTP 429 from the chat limiter),
  `missing_context` (supplier instruction, with a `missing[]` list),
  `invalid_folder`, `invalid_replaces`, `invalid_user`.

## Terminology

The brief's **workspace** is the prototype's **shipment** (`Постачання`). REST
paths use `/api/workspaces`; the entity carries `number`, `supplier`, `status`.

## File status mapping

Backend emits `queued | indexing | ready | error`. The prototype's status dot
uses `queued | indexing | done`, so the frontend maps **`ready → done`**
(«Готовий»). `error` should surface `errorReason`.

## Workspace status values

As of Phase 2 the workspace `status` set is a **superset**:
`active | draft | done` (legacy/manual) **plus** the derived customs pipeline
`docs_in_progress | docs_complete | customs_ready`. Status is auto-derived after
checklist/discrepancy recomputes (advances forward only, never past a manual
`done`) and can be manually overridden via `PATCH /api/workspaces/:id/status`.
**Frontend TODO:** `frontend/lib/types.ts` `WorkspaceStatus` still lists only the
three legacy values and the create modal hardcodes `active` — update in a later FE
pass.

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
Creates the workspace **and** the 8-folder customs skeleton (`01_Contract_Invoice_PackingList … 08_Final`).
Response `201`: `{ "workspace": { "id","number","supplier","status","created_at" } }`

### `GET /api/workspaces`  (auth)
Response `200`: `{ "workspaces": [ { "id","number","supplier","status","created_at" } ] }`

### `GET /api/workspaces/:id`  (auth)
Response `200`:
```json
{
  "workspace": { "id","number","supplier","status","created_at",
                 "contract_type","intake_complete","product_category",
                 "incoterm","transport_mode","origin_country","responsible_user_id" },
  "folders": [ { "id","name","position" } ]
}
```

### `PATCH /api/workspaces/:id`  (auth)
Request (all optional): `{ "number"?, "supplier"?, "contract_type"?:"bilateral"|"trilateral"|null,
"product_category"?:string|null, "incoterm"?:string|null, "transport_mode"?:string|null,
"origin_country"?:string|null, "responsible_user_id"?:uuid|null, "intake_complete"?:boolean }`.
Sets intake/contract fields. When `intake_complete` is true, the checklist is
(re)computed and the derived status refreshed. `400 invalid_user` if
`responsible_user_id` doesn't exist.
Response `200`: `{ "workspace": {…}, "checklist"?: [ {…} ] }` (checklist present when intake complete).

### `PATCH /api/workspaces/:id/status`  (auth)
Request: `{ "status": "active"|"draft"|"done"|"docs_in_progress"|"docs_complete"|"customs_ready" }`
(manual override). Response `200`: `{ "workspace": { "id","number","supplier","status","created_at" } }`.

### `PATCH /api/workspaces/:id/intake`  (auth)
Request (all optional): `{ "contract_type"?:"bilateral"|"trilateral"|null, "product_category"?,
"incoterm"?, "transport_mode"?, "origin_country"? }`. Sets shipment context and
**auto-computes** `intake_complete` (true once all five are present; recomputes the
checklist + status on completion).
Response `200`: `{ "workspace": {…}, "checklist"?: [ {…} ] }`.

---

## Parties (contract structure)

### `GET /api/workspaces/:id/parties`  (auth)
Response `200`: `{ "parties": [ { "id","role","company_name","is_internal","country","contact_info" } ] }`.

### `POST /api/workspaces/:id/parties`  (auth)
Request: `{ "parties": [ { "role":"our_company"|"supplier"|"intermediary", "company_name",
"is_internal"?, "country"?, "contact_info"? } ] }` — **bulk replace**. Validation only
**warns** (never hard-fails) on unusual role combinations for the contract type.
Response `200`: `{ "parties": [ {…} ], "warnings": [ string ] }`.

---

## Files

### `POST /api/workspaces/:id/files?folderId=<uuid>&replacesFileId=<uuid>`  (auth, multipart)
- `multipart/form-data` with one or more file parts. `folderId` (query) optional.
- `replacesFileId` (query) optional: marks this upload as a **new version** of an
  existing file — the new row gets `version = prev+1` + `replaces_file_id`, and the
  previous file's `is_latest` flips to false. Applies to the first accepted file.
  `400 invalid_replaces` if the id isn't in this workspace.
- Allow-list: `pdf, docx, xlsx, csv, png, jpg/jpeg`. Anything else (incl.
  executables) is rejected. Per-file size limit `MAX_UPLOAD_BYTES` (default 25 MB).
- On accept: stores to disk, writes a `queued` row, enqueues a background index
  job, and emits a `file_status` event (see the events channel).
Response `201`: `{ "files": [ { "id","name","type","status":"queued","folderId","version","replacesFileId" } ], "rejected": [ { "name","reason" } ] }`
Response `415` when nothing valid was uploaded: `{ "error":"no_valid_files", "rejected":[…] }`

### `GET /api/workspaces/:id/files/:fileId/history`  (auth)
Full version chain for a document (walks `replaces_file_id` both ways).
Response `200`: `{ "versions": [ { "id","name","version","replacesFileId","isLatest","createdAt" } ] }` (ordered by `version`).

### `GET /api/workspaces/:id/files`  (auth)
Response `200`: `{ "files": [ { "id","folderId","name","type","status","errorReason","sizeBytes","createdAt","version","isLatest","replacesFileId" } ] }`
(the UI shows only `isLatest` files; superseded versions are reachable via the history endpoint).

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
tool-use loop over the tools it chooses at runtime — retrieval (`search_documents`,
`read_file`, `list_files`) plus shipment tools (`get_checklist`,
`get_discrepancies`, `generate_supplier_instruction`, `generate_report`,
`get_missing_context`, `save_workspace_context`, `classify_and_file`,
`sort_inbox`, `compare_document_versions`) — and streams:

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

## Shipment intelligence (Phase 2)

Results below are **computed deterministically** from stored structured
extractions (`document_extractions`) / checklist items — not generated by the LLM
at read time. Structured extraction runs in the indexing worker once a file is
`ready` (gated by `EXTRACTION_ENABLED`).

### `POST /api/workspaces/:id/supplier-instruction`  (auth)
Generates + persists a supplier instruction letter (Markdown).
Response `200`: `{ "instruction": string(markdown), "artifactId": uuid }`.
Response `400`: `{ "error":"missing_context", "missing": ["product_category", "incoterm", …] }`
when required intake fields / a supplier party are absent (fails loudly, never fabricates).

### `GET /api/workspaces/:id/checklist`  (auth)
Recomputes + returns the completeness checklist and derived status.
Response `200`: `{ "items": [ { "requirement_key", "status":"missing"|"received"|"verified", "source_file_id":uuid|null } ], "status": <workspace status> }`.

### `GET /api/workspaces/:id/discrepancies`  (auth)
Deterministic invoice/PO/packing-list reconciliation; also saves a
`discrepancy_report` artifact.
Response `200`: `{ "discrepancies": [ { "field", "expected", "actual", "severity":"error"|"warning"|"info" } ], "artifactId": uuid }`.

### `POST /api/workspaces/:id/compare-versions`  (auth)
Request: `{ "fileIdA": uuid, "fileIdB": uuid }` (both must be in the workspace).
Field-level diff of the two files' latest structured extractions.
Response `200`: `{ "fileIdA","fileIdB","differences": [ { "field","a","b" } ] }`.

### `POST /api/workspaces/:id/report`  (auth)
Generates + persists a self-contained styled HTML shipment report
(`generated_artifacts` type `shipment_report_html`).
Response `200`: `{ "artifactId": uuid, "html": string }`.

### `GET /api/workspaces/:id/export`  (auth)
**Binary** `application/zip` (`Content-Disposition: attachment`). Streams all
folders/files (inbox → `_Inbox/`, superseded versions → `_OldVersions/`) plus a
`_Generated/` folder with the latest artifacts (supplier instruction, discrepancy
report, checklist snapshot, `shipment_report.html`). `_Generated/` is regenerated
if older than the newest uploaded file.

---

## Users & notifications

### `GET /api/users`  (auth)
Minimal directory for choosing a `responsible_user_id`.
Response `200`: `{ "users": [ { "id","email","name" } ] }`.

### `GET /api/notifications`  (auth)
Current user's in-app notifications (reminders). Delivery is **in-app only** —
the stack has no email/SMTP provider. Mark-read + live push are deferred.
Response `200`: `{ "notifications": [ { "id","workspace_id","type","message","read","created_at" } ] }`.

---

## Health

### `GET /health`  (no auth) → `{ "status": "ok" }`
