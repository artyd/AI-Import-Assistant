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

### `DELETE /api/workspaces/:id`  (auth)
Deletes the shipment and everything it owns — folders, files, conversations +
messages, extractions, checklist, parties, notifications, artifacts (DB cascade),
plus its Qdrant vectors and on-disk files. Irreversible.
Response `200`: `{ "ok": true }`. `404 not_found` if not owned/found.

### `GET /api/workspaces/:id`  (auth)
Response `200`:
```json
{
  "workspace": { "id","number","supplier","status","created_at",
                 "contract_type","intake_complete","product_category",
                 "incoterm","incoterm_in","incoterm_out",
                 "transport_mode","origin_country","destination_country",
                 "responsible_user_id" },
  "folders": [ { "id","name","position" } ]
}
```

### `PATCH /api/workspaces/:id`  (auth)
Request (all optional): `{ "number"?, "supplier"?, "contract_type"?:"bilateral"|"trilateral"|null,
"product_category"?:string|null, "incoterm"?:string|null,
"incoterm_in"?:string|null, "incoterm_out"?:string|null, "transport_mode"?:string|null,
"origin_country"?:string|null, "destination_country"?:string|null,
"responsible_user_id"?:uuid|null, "intake_complete"?:boolean }`. `incoterm_in` is the
incoming (buy-side) Incoterm and `incoterm_out` the outgoing (sell-side) one; the legacy
`incoterm` is kept in sync with `incoterm_in`.
Sets intake/contract fields. When `intake_complete` is true, the checklist is
(re)computed and the derived status refreshed. `400 invalid_user` if
`responsible_user_id` doesn't exist.
Response `200`: `{ "workspace": {…}, "checklist"?: [ {…} ] }` (checklist present when intake complete).

### `PATCH /api/workspaces/:id/status`  (auth)
Request: `{ "status": "active"|"draft"|"done"|"docs_in_progress"|"docs_complete"|"customs_ready" }`
(manual override). Response `200`: `{ "workspace": { "id","number","supplier","status","created_at" } }`.

### `PATCH /api/workspaces/:id/intake`  (auth)
Request (all optional): `{ "contract_type"?:"bilateral"|"trilateral"|null, "product_category"?,
"incoterm"?, "incoterm_in"?, "incoterm_out"?, "transport_mode"?, "origin_country"?,
"destination_country"? }`. Sets shipment context and **auto-computes** `intake_complete`
(true once the five core fields — contract_type/product_category/**incoterm_in**/transport_mode/
origin_country — are present; `incoterm_out` and `destination_country` are settable but do
not gate completeness). Recomputes the checklist + status on completion.
Response `200`: `{ "workspace": {…}, "checklist"?: [ {…} ] }`.

### `POST /api/workspaces/:id/duplicate`  (auth)
Clones a shipment's context (intake scalars + a fresh folder skeleton + parties);
does **not** copy files, conversations, extractions, checklist items, or artifacts.
The copy's `number` is `"<src>-копія"` and `status` is `draft`.
Request: `{}`. Response `201`: `{ "workspace": {…} }`.

---

## Collections (Збірник / consolidated cargo)

A second top-level entity alongside workspaces, for grouping documents of a
multi-supplier consolidated shipment. Collections have no intake / checklist /
status-derivation — status is a plain tri-state (`active`/`draft`/`done`).

### `POST /api/collections`  (auth)
Request (all optional): `{ "number"?: string, "supplier"?: string, "status"?: "active"|"draft"|"done" }`
When `number` is omitted it defaults to `Збірник <DD.MM>` (today's UTC date, e.g. `Збірник 14.09`);
`supplier` defaults to `""` and `status` to `draft`.
Creates the collection **and** the 8-folder skeleton
(`01_Маніфест`, `02_Інвойси`, `03_Сертифікати_походження`, `04_MSDS_SDS`,
`05_Якість_CoA`, `06_Дозволи_ліцензії`, `07_Транспорт`, `08_Митниця`).
Response `201`: `{ "collection": { "id","number","supplier","status","created_at" } }`

### `GET /api/collections`  (auth)
Response `200`: `{ "collections": [ { "id","number","supplier","status","created_at" } ] }`

### `GET /api/collections/:id`  (auth)
Response `200`:
```json
{
  "collection": { "id","number","supplier","status","created_at" },
  "folders": [ { "id","name","position" } ]
}
```
`404 not_found` if not owned/found.

### `DELETE /api/collections/:id`  (auth)
Deletes the collection and everything it owns — folders, files, conversations
(DB cascade) — and purges its on-disk storage dir (`STORAGE_DIR/<collectionId>`).
Irreversible. **No Qdrant purge:** collection files are never embedded (see
"Collection files" below). Response `200`: `{ "ok": true }`. `404 not_found` if not
owned/found.

### `PATCH /api/collections/:id`  (auth)
Request (all optional): `{ "number"?: string, "supplier"?: string,
"status"?: "active"|"draft"|"done" }`. Whitelist-updates the provided columns.
Response `200`: `{ "collection": { "id","number","supplier","status","created_at" } }`.
`404 not_found` if not owned/found.

---

## Parties (contract structure)

### `GET /api/workspaces/:id/parties`  (auth)
Response `200`: `{ "parties": [ { "id","role","company_name","is_internal","country","contact_info" } ] }`.

### `POST /api/workspaces/:id/parties`  (auth)
Request: `{ "parties": [ { "role":string, "company_name",
"is_internal"?, "country"?, "contact_info"? } ] }` — **bulk replace**. `role` is normalized
to one of three fixed slots: `sender` (Від кого / постачальник), `intermediary`
(Через кого / посередник, optional), `recipient` (Кому / одержувач). Legacy/free-text
labels are mapped into these slots on write. `contact_info` may carry
`{ "source":"auto"|"manual", "source_files"?:string[] }` to mark auto-extracted vs
manually-entered parties. Validation only **warns** (never hard-fails) on unusual slot
combinations for the contract type.
Response `200`: `{ "parties": [ {…} ], "warnings": [ string ] }`.

### `POST /api/workspaces/:id/parties/suggest`  (auth)
Party + Incoterm suggestions aggregated from stored document extractions (no new
LLM call — reuses `document_extractions`). **Read-only**: does not write anything.
Request: `{}`. Response `200`: `{ "suggestions": [ { "role":"sender"|"intermediary"|"recipient",
"company_name","country","source_files":string[], "confidence":number } ],
"suggested_contract_type": "bilateral"|"trilateral"|null,
"suggested_incoterm_in": string|null, "suggested_incoterm_out": string|null }`.

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
- **Content dedup:** an exact-content match (SHA-256 of the bytes, scoped to the
  workspace's `is_latest` files, and within the same upload batch) is skipped and
  reported in `rejected` with `reason: "duplicate_of:<existing name>"`. Skipped when
  `replacesFileId` is set (an explicit version-replace is never deduped).
- On accept: stores to disk, writes a `queued` row (with `content_hash`), enqueues a
  background index job, and emits a `file_status` event (see the events channel).
Response `201`: `{ "files": [ { "id","name","type","status":"queued","folderId","version","replacesFileId" } ], "rejected": [ { "name","reason" } ] }`
Response `415` when nothing valid was uploaded: `{ "error":"no_valid_files", "rejected":[…] }`

### `GET /api/workspaces/:id/files/:fileId/history`  (auth)
Full version chain for a document (walks `replaces_file_id` both ways).
Response `200`: `{ "versions": [ { "id","name","version","replacesFileId","isLatest","createdAt" } ] }` (ordered by `version`).

### `GET /api/workspaces/:id/files`  (auth)
Response `200`: `{ "files": [ { "id","folderId","name","type","status","errorReason","sizeBytes","createdAt","version","isLatest","replacesFileId","folderReason","folderConfidence","suggestedFolderId" } ] }`
(the UI shows only `isLatest` files; superseded versions are reachable via the history endpoint).
`folderReason` (human-readable "why this folder") + `folderConfidence` (`high`|`medium`|`low`)
explain the auto-classification; `suggestedFolderId` is set for a low-confidence guess left
in the inbox for manual confirmation.

### `DELETE /api/workspaces/:id/files/:fileId`  (auth)
Deletes the disk file, its vector chunks, and the row; emits `file_status: deleted`.
Response `200`: `{ "ok": true }`

### Extensions (to support the tree UI)
- `POST /api/workspaces/:id/folders` — `{ "name": string }` → `201 { "folder": { "id","name","position" } }`
- `PATCH /api/workspaces/:id/files/:fileId` — `{ "name"?: string, "folderId"?: string|null }` → `200 { "file": {…} }`
- `POST /api/workspaces/:id/sort-inbox` (auth, no body) — classify & file every inbox
  file (`folder_id IS NULL`) into its skeleton folder (move-only; uses stored
  extractions, so OCR'd scans sort too). High/medium-confidence files are moved;
  low-confidence guesses stay in the inbox with a `suggested` folder.
  → `200 { "moved": [ { "fileId","name","to","reason" } ], "unclassified": [ { "fileId","name","suggested":string|null,"reason":string|null } ] }`

### `GET /api/workspaces/:id/files/:fileId/content`  (auth)
Streams the stored file bytes inline (`Content-Type` by file type, `Content-Disposition: inline`)
for in-app preview / download. The browser fetches it with the Bearer header and renders it
from a blob URL (PDF in an `<iframe>`, images in `<img>`). `404 not_found` if not owned/found.

### `POST /api/workspaces/:id/files/:fileId/reindex`  (auth, no body)
Requeue indexing for a file (e.g. one whose previous run errored): resets status
to `queued`, clears `error_reason`, enqueues a fresh index job, emits `file_status`.
Response `200`: `{ "ok": true }`. `404 not_found` if the workspace/file isn't found.

### `POST /api/workspaces/:id/files/:fileId/classify`  (auth, no body)
Auto-sorts a single file into its skeleton folder (move-only; same classifier as the
agent's `classify_and_file` tool). Used by the chat right after a paperclip upload.
Response `200`: `{ "fileId": string, "folderName": string | null }` — `folderName` is
the destination folder name when filed, or `null` when the file was left in the inbox
(`folder_id IS NULL`; unknown/`other` type) so the client can ask the user to pick.
Move confirmation reuses `PATCH /api/workspaces/:id/files/:fileId` with `{ "folderId" }`.
`404 not_found` if the workspace or file isn't owned/found.

---

## Collection files (Збірник)

> **Not indexed / not embedded (no RAG).** Unlike workspace files, collection
> files never enter the embedding/Qdrant pipeline. They are panel documents /
> certificates plus a manifest, parsed **directly** by the Phase-B analysis
> engine. Uploads therefore skip `queued`/`indexing` and are stored as
> `status: "ready"` immediately — there is no index job, no Qdrant, and no
> `file_status` events channel for collections.

All routes are scoped by `getOwnedCollection` and `404 not_found` if the
collection (or file/folder) isn't owned/found.

### `POST /api/collections/:id/files?folderId=<uuid>`  (auth, multipart)
- `multipart/form-data` with one or more file parts. `folderId` (query) optional;
  `400 invalid_folder` if it doesn't belong to this collection.
- Same allow-list (`pdf, docx, xlsx, csv, png, jpg/jpeg`), per-file size limit
  (`MAX_UPLOAD_BYTES`), and exact-content SHA-256 dedup (scoped to the collection's
  `is_latest` files + within the batch) as the workspace upload. Duplicates are
  reported in `rejected` with `reason: "duplicate_of:<existing name>"`.
- On accept: stores to disk under the collection's id namespace and writes a
  `ready` row (with `content_hash`). **No index job, no Qdrant, no events.**
Response `201`: `{ "files": [ { "id","name","type","status":"ready","folderId","version","replacesFileId":null } ], "rejected": [ { "name","reason" } ] }`
Response `415` when nothing valid was uploaded: `{ "error":"no_valid_files", "rejected":[…] }`

### `GET /api/collections/:id/files`  (auth)
Response `200`: `{ "files": [ { "id","folderId","name","type","status","errorReason","sizeBytes","createdAt","version","isLatest","replacesFileId" } ] }`
(collection files are always `status: "ready"` with `errorReason: null`).

### `DELETE /api/collections/:id/files/:fileId`  (auth)
Deletes the on-disk file and the row. No Qdrant. Response `200`: `{ "ok": true }`.

### `PATCH /api/collections/:id/files/:fileId`  (auth)
`{ "name"?: string, "folderId"?: string|null }` → `200 { "file": { "id","name","folderId","type","status" } }`.
`400 invalid_folder` if the target folder isn't in this collection.

### `GET /api/collections/:id/files/:fileId/content`  (auth)
Streams the stored file bytes inline (same behaviour as the workspace content route).

### `POST /api/collections/:id/folders`  (auth)
`{ "name": string }` → `201 { "folder": { "id","name","position" } }` (folder scoped to the collection).

---

## Consolidated analysis (Збірник)

The analysis engine turns a **manifest** (uploaded file, Google Sheets link, or
pasted table) into a per-line customs breakdown: митна вартість (CIF), мито, ПДВ,
країна походження, and EU/UA broker checks. Numbers are computed deterministically
(engine + built-in tariff/MFN tables); the AI step only fills descriptive fields
(origin type, category, per-item EU/UA checks, risk). If the AI step fails it
**degrades gracefully** — the deterministic result is still returned, with
`aiDegraded: true` and every row flagged `needsReview`.

### `POST /api/collections/:id/analyze`  (auth) — run analysis
Accepts **either** `multipart/form-data` with a single file field (`.xlsx`/`.xls`/
`.csv`/`.txt`) **or** JSON with exactly one of:
- `{ "sheetUrl": string }` — a Google Sheets link (exported as CSV server-side);
- `{ "text": string }` — a pasted CSV/TSV table.

`404 not_found` when the collection is not owned by the caller. `415
unsupported_type` (bad file ext), `413 too_large`, `422 analysis_failed`
(`{ message }`), or `400 invalid_request` on a malformed JSON body.

Runs the engine, persists one `analyses` row + one `archive_records` row (the
archive is FIFO-capped at 50 newest per owner), and returns `201 { "analysis": <AnalysisResult> }`.

**`AnalysisResult`** (the frontend card renders these exact fields):
```jsonc
{
  "id": "uuid",                 // persisted analysis id (null before persistence)
  "meta": {
    "sheet": "06.05",           // selected sheet name
    "date": "06.05.2026" | null,// parsed sheet date (uk-UA), or null
    "reason": "…",              // why this sheet was chosen
    "ignored": ["Лист2", "…"]   // other sheet names skipped
  },
  "rows": [
    {
      "name": "Гіалуронова кислота",
      "code": "3913900090" | null,   // УКТЗЕД
      "qtyKg": 25,
      "price": 210.0,                // per-kg, shipment currency
      "dutyRate": 6.5 | null,        // %
      "category": "…",
      "origin": "Синтетичне" | null, // origin type (KB-confident, else AI)
      "risk": "Критичний" | "Середній" | "Низький" | null,
      "riskNote": "…",
      "cif": 5250.0,                 // customs value
      "duty": 341.25 | null,
      "vat": 1118.25 | null,
      "eu": [ { "item": "…", "status": "green|yellow|red", "note": "…" } ],
      "ua": [ { "item": "…", "status": "green|yellow|red", "note": "…" } ],
      "needsReview": true
    }
  ],
  "totals": { "cif": 7650.0, "duty": 0, "vat": 0, "payable": 0, "count": 2 },
  "source": "manifest.xlsx",    // source label (filename | Google Sheets | Вставлена таблиця)
  "sheet": "06.05",             // mirror of meta.sheet
  "criticalAlert": "",          // AI cross-cutting alert (may be empty)
  "nctsList": ["…"],            // AI NCTS checklist (may be empty)
  "warnings": ["…"],            // deterministic warnings
  "hasHigh": false,             // any high-risk item / red check
  "aiDegraded": false           // true when the AI step failed (deterministic-only)
}
```

### `GET /api/analyses/archive`  (auth) — archive list
`200 { "records": [ { "id","collectionId","source","sheet","itemCount","payable","hasHigh","createdAt" } ] }`,
newest first, owner-scoped.

### `DELETE /api/analyses/archive/:id`  (auth) — remove one archive record
`200 { "ok": true }`, or `404 not_found`. Owner-scoped.

### `GET /api/analyses/:id/xlsx`  (auth) — export
Rebuilds the `.xlsx` report from the stored analysis (sheets: Зведена / Детальний /
Перевірки ЄС / Розмитнення UA) and streams it as an attachment
(`analysis-<sheet>.xlsx`). Owner-scoped via the analysis's collection; `404
not_found` on miss.

---

## Chat (SSE)

### `POST /api/workspaces/:id/chat`  (auth, per-user rate-limited)
Request: `{ "message": string, "conversationId"?: string(uuid) }`
Omitting `conversationId` starts a new conversation.

Response: `Content-Type: text/event-stream`. The single agent ("Штурман") runs a
tool-use loop over the tools it chooses at runtime — retrieval (`search_documents`,
`read_file`, `list_files`) plus shipment tools (`get_checklist`,
`get_discrepancies`, `get_risks`, `generate_supplier_instruction`, `generate_report`,
`get_missing_context`, `save_workspace_context`, `classify_and_file`,
`sort_inbox`, `normalize_shipment_files`, `compare_document_versions`) — and streams:

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

### Chat kinds

Every conversation has a `chat_kind`, which decides its scope and tool set. All
three kinds share the **same SSE contract above** (`token` / `tool_call` /
`tool_result` / `done` / `error`, plus `: ping` keep-alives) and the same
per-user rate limiter. They differ only in scope and available tools:

| kind | endpoint | scope | tools |
|------|----------|-------|-------|
| `supply` | `POST /api/workspaces/:id/chat` | a shipment (workspace) | full set (unchanged) |
| `normal` | `POST /api/chats` | global (the user) | none — general ЗЕД/customs consultant answering from knowledge |
| `consolidated` | `POST /api/collections/:id/chat` | a collection (Збірник) | one tool — `run_consolidated_analysis` (analyses the collection's latest manifest: CIF/мито/ПДВ per line, origin, EU/UA checks; persists the result and returns an `analysisId` in the reply text for the FE to fetch via `GET /api/analyses/:id/xlsx` / the stored `AnalysisResult`) |

The `supply` chat is **unchanged** — same workspace-scoped agent, same full tool
set, same grounding prompt.

### `POST /api/chats`  (auth, per-user rate-limited) — normal (global) chat
Request: `{ "message": string, "conversationId"?: string(uuid) }`
Omitting `conversationId` starts a new global conversation for the user.
Response: `text/event-stream` — same events as above. No `tool_call` /
`tool_result` events are emitted (no tools); `citations` is empty.

### `POST /api/collections/:id/chat`  (auth, per-user rate-limited) — consolidated chat
`404` if the collection is not owned by the user. Request/response identical in
shape to `POST /api/chats`; the conversation is scoped to the collection. For now
no tools run (no `tool_call` / `tool_result` events); the manifest-analysis
engine (CIF / мито / ПДВ per line, origin, EU/UA checks) arrives in Phase B.

---

## Conversations

Conversations are scoped by `chat_kind`. Supply conversations hang off a
workspace, consolidated off a collection, normal off the user.

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

### `GET /api/chats`  (auth) — normal (global) conversations for the user
Response `200`: `{ "conversations": [ { "id","title","created_at","updated_at" } ] }`

### `GET /api/chats/:convId`  (auth) — messages of a normal conversation (owner-verified, `404` on miss)
Same message shape as the workspace variant above.

### `GET /api/collections/:id/conversations`  (auth) — a collection's consolidated conversations
`404` if the collection is not owned. Response shape as above.

### `GET /api/collections/:id/conversations/:convId`  (auth) — messages of a consolidated conversation
`404` if the collection is not owned or the conversation isn't in that collection.
Same message shape as above.

---

## Live events channel (SSE)

### `GET /api/workspaces/:id/events`  (auth via `?access_token=`)
`Content-Type: text/event-stream`. Forwards real-time file indexing-status
transitions so the file-tree dots update without polling.

| event | data |
|-------|------|
| `file_status` | `{ "fileId": string, "status": "queued"|"indexing"|"ready"|"error"|"deleted", "name"?: string, "errorReason"?: string|null, "folderId"?: string|null }` |

`folderId` is present when the worker auto-filed an inbox file (e.g. a scan classified via OCR); the tree moves the file into that folder live.

Consumable with the native `EventSource` (GET). Emits `: ping` keep-alives.

---

## Shipment intelligence (Phase 2)

Results below are **computed deterministically** from stored structured
extractions (`document_extractions`) / checklist items — not generated by the LLM
at read time. Structured extraction runs in the indexing worker once a file is
`ready` (gated by `EXTRACTION_ENABLED`).

### `POST /api/workspaces/:id/supplier-instruction`  (auth)
Generates + persists a supplier instruction letter (Markdown).
Request (optional): `{ "sections"?: ("documents"|"invoice_packing"|"marking"|"certificates"|"timelines")[] }`
— a subset of letter sections (the constructor UI toggles these). Omit for all sections.
Response `200`: `{ "instruction": string(markdown), "artifactId": uuid }`.
Response `400`: `{ "error":"missing_context", "missing": ["product_category", "incoterm_in", …] }`
when required intake fields / a sender party are absent (fails loudly, never fabricates).

### `GET /api/workspaces/:id/risks`  (auth)
Proactive current + upcoming problems, computed deterministically from extractions,
the persisted checklist, and intake (never LLM-generated). Categories: `expiry`
(expired/expiring certificates), `missing_docs`, `discrepancy`, `deadline`.
Response `200`: `{ "risks": [ { "code", "category", "severity":"error"|"warning"|"info",
"title", "detail", "source_file_id":uuid|null } ] }` (most-severe first). The indexing
worker also raises an in-app `risk_alert` notification to the responsible user on new
error-level risks.

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

## News

A single shared feed of import/customs-relevant news, ingested from public
RSS/Atom sources by the worker cron (`NEWS_CRON`, gated by `NEWS_ENABLED`) and
served read-only. **Retention:** only *fresh* news is ever returned or counted —
items with `published_at` older than `NEWS_RETENTION_DAYS` (default `14`) are
excluded from the API and purged on each ingest run. Not workspace-scoped.

**Rubric keys** (frozen; the 8 keys the FE filter bar renders — the aggregate
"Всі новини" tab is FE-only, requested by omitting `rubric` or passing `all`):

| key | Ukrainian label |
| --- | --- |
| `customs` | Митниця України |
| `ncts` | Транзит ЄС / NCTS |
| `freight` | Фрахтові ставки |
| `sanctions` | Санкції / експортний контроль |
| `ports` | Порти |
| `fx` | Курси валют / ПДВ |
| `pharma` | Фарм/хім регулювання |
| `adr` | ADR / небезпечні |

### `GET /api/news?rubric=<key>`  (auth)
Fresh news within the retention window, newest first (`published_at DESC`, capped
at 200 items). `rubric` omitted or `all` ⇒ every rubric; any of the 8 keys ⇒
that rubric only (an unknown value is treated as `all`).
Response `200`: `{ "items": NewsItem[], "counts": { <rubric>: number, …, "total": number } }`
where `NewsItem = { id, rubric, title, summary, source, url, published_at }`
(`published_at` is an ISO string or `null`). `counts` has all 8 rubric keys
(zero-filled) plus `total`, computed over the same retention window.

---

## Health

### `GET /health`  (no auth) → `{ "status": "ok" }`
