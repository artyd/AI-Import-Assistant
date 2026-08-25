# Read-Only Audit — File Ingestion Robustness (6 failed files, "Метопрен" shipment)

> **Status: AUDIT + PLAN ONLY.** No files were modified, no migrations run, nothing committed.
> This document is the findings report. The next step is `phase-1-action-prompt.md`.

## Context

6 files in shipment №2026-1308 ("Метопрен") ended up with `status = 'error'` and sat behind the
sidebar's "Повторити невдалі (6)" button:

- `рахунок 42.pdf`
- `Inv PL S-METHOPRENE.pdf` (uploaded a second time from a different source folder — a
  byte-identical duplicate of an already-`ready` file of the same name)
- `СчетНаОплатуПокупателю UA10023782   22.07.2026.pdf`
- `PL_Eprinil додаток.pdf`
- `DEP-1-DE2329875-0071-DE003302_00000000993976127-V#20260723-124657832-360.pdf`
- `Original 2 - (for Consignee) - HAWB No_ AID0009199[2][2].pdf`

The initial working theory (before reading the code) was that unusual filename characters —
Cyrillic, `#`, `[ ]`, runs of spaces — were breaking the upload/index pipeline. **That theory does
not hold up against the actual code and is not the recommended fix.** See Findings below.

---

## Findings

### F1 — Filename UTF‑8 decoding is already correct (busboy 3.2.0)

`package-lock.json` pins `@fastify/busboy@3.2.0`. Its `lib/utils/parseParams.js` explicitly
re-decodes a plain (non‑RFC2231) `filename="..."` parameter as UTF‑8:

```js
} else if (tmp) {
  tmp = decodeText(tmp, 'binary', 'utf8')   // parseParams.js, both the mid-string and
}                                            // end-of-string branches
```

This is precisely the fix for the classic "busboy/multer decodes multipart filenames as latin1"
bug. At this pinned version, that bug **does not apply** — Cyrillic filenames sent as raw UTF‑8
bytes (which is what Chrome/Firefox send for a plain `filename=` param) decode correctly. This
matches what we actually observe: other Cyrillic-named files in the same shipment
(`Контракт.pdf`, `Инструкція метопрен.docx`) indexed fine.

### F2 — Disk paths are already sanitized

`src/services/storage.ts::safeName()` strips path separators and replaces anything outside
`[\w.\-() +]` (which includes `#`, `[`, `]`) with `_` before the file ever touches disk
(`diskPathFor()`). The **original** name is preserved untouched in `files.name` for display; only
the on-disk filename is sanitized. So special characters cannot break the write to disk either.

### F3 — Classification already treats Cyrillic/special chars safely

`src/services/classify.ts::normalizeName()` — `s.toLowerCase().replace(/[^0-9a-zа-яёіїєґ]+/gi, ' ')`
— explicitly folds Cyrillic together with digits/Latin and collapses every run of anything else
(including `#`, `[]`, multiple spaces) into a single space. This is not where the failure is.

### F4 — The real per-file error is already captured **and already shown in the UI**

`src/worker/index.ts::processJob()` wraps `extractText` → OCR fallback → `chunkPages` →
`getEmbeddingProvider().embed()` → `upsertChunks()` in one try/catch. On failure it stores the
real exception message:

```ts
await setStatus(file.id, file.workspace_id, 'error', reason); // reason = err.message.slice(0, 300)
```

`error_reason` is returned by `GET /api/workspaces/:id/files` and **already rendered** by
`frontend/components/FileTree.tsx:206-244` as the `title` tooltip on each file's retry icon:
`Переіндексувати (помилка: ${file.errorReason})`.

**→ Before writing any more code, hover the red retry icon on each of the 6 files (or run
`SELECT name, error_reason FROM files WHERE workspace_id = '<id>' AND status = 'error';`
read-only against Postgres) to see the actual exception** — e.g. a `pdf-parse` failure on a
malformed/encrypted PDF, a Voyage AI embedding error, or a Qdrant error. Filename content is very
unlikely to be it, given F1–F3.

### F5 — Confirmed real gap: zero content-based deduplication

`src/routes/files.ts`, the `POST /api/workspaces/:id/files` handler, inserts **every** uploaded
part as a new `files` row with no duplicate check of any kind — not by name, not by content. This
is exactly why `Inv PL S-METHOPRENE.pdf`, present in two different source folders of the same
shipment with identical bytes, became two independent `files` rows, each independently queued via
`enqueueIndexJob`. This is a real, fixable gap and is in scope.

The existing "retry failed" button (`frontend/app/workspaces/[id]/page.tsx:427-430`,
`retryErrored`) simply loops `status === 'error'` files through the existing per-file
`POST …/reindex` endpoint (`mapLimit(targets, 4, reindexFile)`) — a bulk endpoint doesn't exist,
but isn't needed; the new chat tool below can call the same underlying primitives.

---

## Decisions (confirmed with the product owner)

1. **Naming:** original filename stays as the display name (`files.name`, unchanged); dedup keys
   off a separate `content_hash` column, not a sanitized/rewritten name.
2. **Duplicate policy:** an exact content-hash match (scoped to the workspace, among
   `is_latest = true` files) is auto-treated as a duplicate and **not** re-indexed — it's reported
   back as rejected, referencing the existing file.
3. **Chat command:** add a Shturman tool to (re)normalize a specific shipment on demand — backfills
   `content_hash` for already-uploaded files that predate this change, reports any pre-existing
   duplicate pairs (report only — never auto-deletes), and can bulk-retry currently-errored files
   from chat instead of the sidebar button.

## Explicitly out of scope for this pass

**Filename character sanitization/renaming.** F1–F3 show it isn't the failure mechanism, and
rewriting `Контракт.pdf` → `Kontrakt.pdf` etc. would only make the UI less readable for the logist
for no measurable benefit. Revisit only if the F4 error-reason check on the actual 6 files turns
out to genuinely be filename-related (it would show up plainly in `error_reason`).

## Plan

One small, additive phase — see `phase-1-action-prompt.md`:
1. `content_hash` column + index (idempotent `ALTER TABLE`, following the existing pattern).
2. `contentHashOf()` helper in `storage.ts`, reused by both the upload path and the backfill.
3. Upload-path dedup in `files.ts` (DB-scoped **and** within the same upload batch).
4. New agent tool `normalize_shipment_files` (chat-triggered): backfill hashes → report duplicate
   pairs → bulk-retry errored files. Mirrors the existing `sort_inbox` tool's shape exactly.
