---
name: indexing-pipeline
description: Reference for the document indexing + hybrid retrieval pipeline in the AI Import Assistant backend. Use when changing text extraction, chunking, embeddings (Voyage/provider), Qdrant storage/search, the BullMQ worker, live file-status events, or the agent's search_documents/read_file tools.
---

# Indexing & retrieval pipeline

Upload → background index → the agent retrieves at query time.

## Flow

1. **Upload** (`src/routes/files.ts`): allow-list check (`storage.ts`
   `isAllowedUpload`), store to disk (`STORAGE_DIR/<workspaceId>/<fileId>-<name>`),
   insert `files` row `status=queued`, `enqueueIndexJob(fileId)`, publish
   `file_status: queued`.
2. **Worker** (`src/worker/index.ts`, BullMQ, concurrency 3):
   `status=indexing` → `extractText` → `chunkPages` → `deleteFileChunks` (re-index
   safety) → `embed(document)` → `upsertChunks` → `status=ready`. On throw:
   `status=error` with reason, then rethrow so BullMQ records/retries.
3. **Live status** (`src/events/fileStatus.ts`): worker publishes to Redis
   pub/sub `file_status:<workspaceId>`; `GET /api/workspaces/:id/events` (SSE)
   forwards `file_status` events to the browser.

## Modules

- **Extraction** `src/services/extract/index.ts` — `extractText(buf, type)` →
  `{ page, text }[]`. PDF keeps per-page (via `pdf-parse` `pagerender`; imported
  from `pdf-parse/lib/pdf-parse.js` to avoid the package's import-time crash).
  docx→mammoth, xlsx/csv→SheetJS (one "page" per sheet, `page:null`), md→raw,
  image→`[]` (OCR is v2). To add a format: extend this + `inferFileType`
  (`domain/folders.ts`) + the allow-list in `storage.ts`.
- **Chunking** `src/services/extract/chunk.ts` — ~800 tokens (≈3200 chars) with
  ~100-token overlap, split on paragraph/sentence boundaries, one page per chunk
  so citations stay precise.
- **Embeddings** `src/services/embeddings/` — `EmbeddingProvider` interface
  (`embed(texts, 'document'|'query')`, `dimension`). `voyage.ts` calls Voyage via
  `fetch` (multilingual → good for Ukrainian), batches of 64. Swap vendors by
  adding an impl + branching in `getEmbeddingProvider()`. Dimension must match
  the Qdrant collection.
- **Qdrant** `src/services/qdrant.ts` — one `documents` collection, Cosine,
  sized to the provider dimension, payload indexes on `workspace_id` + `file_id`.
  `searchWorkspace` filters `must: workspace_id` — retrieval is always
  workspace-scoped. `deleteFileChunks` filters `file_id`.

## Agent tools (`src/agent/tools.ts`)

- `search_documents(query)` → `searchWorkspace` (semantic). `read_file(path,
  range?)` → resolve by filename, `extractText` on demand (works even before
  indexing), optional page/char range, truncated to 12k chars. `list_files()` →
  workspace tree with status. Each returns `{ result, summary, citations }`.
- **Both search + read must stay** — hybrid retrieval is a hard constraint; the
  model picks per query (see `agent/loop.ts`).

## Gotchas

- Qdrant point ids are UUIDs; dedupe/replace is by `file_id` payload filter.
- If you change `EMBEDDING_MODEL` to a different dimension, the existing
  collection is wrong — recreate it (drop the `documents` collection) or version
  the name.
- Voyage/Anthropic calls need real keys; the smoke test's indexing + chat steps
  hit them for real.
