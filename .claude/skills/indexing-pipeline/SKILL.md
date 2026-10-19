---
name: indexing-pipeline
description: Reference for the ingest pipeline (upload → File Markdown → full-text sections → extraction → auto-file → reconcile) and the agent's search_documents/read_file tools. Use when changing conversion/vision OCR, document sections or search, extraction, the BullMQ worker, or live file-status events.
---

# Ingest & retrieval pipeline

Upload → the worker converts the file **once** into File Markdown → everything else
reads that Markdown. No embeddings (ADR-0002).

## Flow

1. **Upload** — `src/documents/files.routes.ts` (shipments) and
   `collectionFiles.routes.ts` (collections): allow-list (`src/lib/storage.ts`),
   content-hash dedup, store to disk, `files` row `status=queued`,
   `enqueueIndexJob` (`src/lib/queue/index.ts`), publish `file_status`.
2. **Worker** — `src/worker/index.ts` (BullMQ, `INDEX_CONCURRENCY`):
   `indexing` → reuse Markdown by content hash or `convertToMarkdown`
   (`src/ingest/markdown/convert.ts`; PDFs/scans/photos via Claude vision in
   5-page windows, `vision.ts`) → `saveFileMarkdown` (`store.ts`: `file_markdown`
   + `document_sections` with a `tsvector`) → `extractFieldsFromMarkdown`
   (`src/ingest/extraction/extractFields.ts` → `document_extractions`) →
   auto-file from the inbox (`src/documents/classify.ts`) → `maybeReconcileBatch`
   (`src/reconciliation/reconcileBatch.ts`) → `ready` | `error` + reason.
3. **Stuck/failed files** — `src/ingest/ingestRetry.ts` sweep, scheduled by
   `src/lib/queue/ingestRetry.ts`.
4. **Live status** — `src/lib/events/fileStatus.ts` (Redis pub/sub) →
   `GET /api/workspaces/:id/events` (`src/documents/events.routes.ts`, SSE, auth
   via one-time `?ticket=`).

## Agent tools (`src/agent/tools/retrieval.ts`)

- `search_documents` → Postgres FTS over `document_sections`
  (`src/ingest/markdown/store.ts`, query builder `searchQuery.ts`).
- `read_file` → the whole stored Markdown of one file.
- `list_files` / `find_files` → the shipment's files with status and version hints.
- **Both search + read must stay**; the model chooses per query.

## Adding a file format

Extend `convertToMarkdown`, `inferFileType` (`src/shipments/folders.ts`) and the
allow-list in `src/lib/storage.ts`.

## Gotchas

- Files indexed before the Markdown pipeline: `npm run migrate:markdown -- --apply`
  (dry-run without `--apply`).
- An all-null extraction is downgraded to `no_fields`/`unreadable` so it reaches
  verification instead of looking read (see the gate at the top of the worker).
- Vision and extraction call Anthropic for real; tests never do.
