# Full audit — poor file analysis & context loss

**Date:** 2026-09-29 · **Type:** read-only root-cause audit (no code changed here).
**Question:** why the agent analyses uploaded files poorly and "loses context" when
working with them. Findings from three focused code investigations (extraction
fidelity · retrieval recall · conversation context). File:line refs are indicative
of the current tree (post the PR #18 input-side fixes).

---

## Executive summary — the main causes (главні причини)

Two independent failure classes compound. The five headline root causes:

1. **Multi-turn amnesia (CONTEXT LOSS #1, CRITICAL).** Conversation history is
   persisted and replayed as **plain `{role, content}` text only**. Every prior
   turn's `tool_use`/`tool_result` — all document text read via `read_file`, all
   `search_documents` hits, all checklist/discrepancy outputs — is **discarded at
   turn end and never replayed**. On turn 2+ the agent sees only its own past
   prose, not the document data, so it "forgets" what it read and must re-retrieve
   from scratch (and often can't). → `conversations.ts`, `loop.ts`, `schema.sql`.
2. **Silent blind search (ANALYSIS, CRITICAL & invisible).** If embedding fails at
   index time (Voyage 429 — free tier 3 RPM; **fallback is `none` by default**),
   the file is still marked **`ready`** with **zero vectors**. `search_documents`
   then returns empty — indistinguishable from "genuinely nothing" — so the agent
   concludes there's no data on a file it can't see. → `worker/index.ts`,
   `embeddings/index.ts`, `config.ts`.
3. **Extraction output truncated & mislabelled `ok` (ANALYSIS, HIGH).** The
   structured-extraction call is capped at `max_tokens: 16000` with **no
   `stop_reason` check**; a large packing list / manifest's `line_items` array is
   cut off mid-way, yet the file is still stored as `ok` (backbone fields present).
   Row-level reconciliation and totals silently under-count. → `extractFields.ts`.
4. **Retrieval top-K = 6, no per-document diversity (ANALYSIS/RECALL, HIGH).** A
   shipment (invoice + packing list + contract + certs) is 40–80 chunks; search
   returns only the 6 globally-highest-scoring, so one big document can occupy all
   6 slots and starve the others. ~<10% recall on multi-doc shipments. →
   `tools.ts:1104`, `qdrant.ts:135`.
5. **`read_file` returns only ~12 000 chars and the agent isn't told to paginate
   (ANALYSIS, MED-HIGH).** Even with good extraction, the agent's own read of a
   long contract sees only the first ~4–5 pages + `…[обрізано]`, then stops. →
   `tools.ts:1161`.

Everything below is the full ranked list. **The two most important are #1
(amnesia) for "context loss" and #2 (blind search) for "poor analysis"** — both are
invisible today (no error, no flag), which is why they've been hard to pin down.

---

## Axis A — Context loss across the conversation

| # | Root cause | Severity | Where |
|---|-----------|----------|-------|
| A1 | **Tool calls/results never persisted; history replayed text-only** → multi-turn amnesia | CRITICAL | `conversations.ts:105-119, 203-212`; `loop.ts:68-71`; `schema.sql:78-87` |
| A2 | Unbounded history replay (no windowing / token budget) — latent now, becomes critical once A1 is fixed naively | HIGH | `conversations.ts:204-212`; `loop.ts:68-71` |
| A3 | In-turn message growth unguarded (12k-char reads × 14 iters, no size cap; every iter re-sends the whole array) | MEDIUM | `loop.ts:42, 98, 122-129`; `tools.ts:1161` |
| A4 | No input-context management (`max_tokens` is output-only; no `countTokens` preflight; overflow → opaque API error) | MEDIUM | `client.ts`, `loop.ts:82-89`; error surfaced at `chat.ts:79-81` |
| A5 | Stored `document_extractions` never surfaced as durable context (reachable only via a tool call each turn; system prompt carries no document data) | MEDIUM | `schema.sql:152-161`; `systemPrompt.ts` |
| A6 | Completed answer persisted only after a full successful turn; a throw loses the streamed text on reload | LOW-MED | `chat.ts:48-81`; `loop.ts:135-148` |

**A1 detail (the core bug).** `appendMessage` writes `content TEXT`, `citations`,
`tool_calls` (=`{tool,input,summary}` chip labels — **not** tool_result bodies);
`getConversationHistory` `SELECT role, content` only; `loop.ts` seeds messages from
those strings. *Within* a turn context is intact (full `msg.content` + tool_results
are appended), but `runAgentTurn` returns only `{text, citations, toolCalls}` and
the tool_result bodies are thrown away. So on the next turn the agent cannot see the
invoice/contract text it read moments earlier.

**Fixes (ordered):** (1) persist + replay real content blocks — add a JSONB block
column (or `message_blocks` table) storing `msg.content` (incl. `tool_use`) and the
`tool_result` array, and return real `ChatMessageParam[]` from history (each
`tool_use` immediately followed by its `tool_result`). (2) Simultaneously add
history windowing + input token budget (A2/A4) so the fix can't overflow context.
(3) Cheap partial mitigation that helps on its own: surface a compact digest of the
workspace's `document_extractions` as a trailing system-prompt block (A5) — durable
document memory that survives regardless of what was read.

---

## Axis B — Poor analysis of the files themselves

### B-reading (how much & how faithfully content is captured)

| # | Root cause | Severity | Where / value |
|---|-----------|----------|---------------|
| B1 | Extraction **output** cap truncates big tables; no `stop_reason` check; still marked `ok` | HIGH | `extractFields.ts:435` `max_tokens: 16000` |
| B2 | Vision path sends whole PDF in ONE call; no page batching; 32 MB / ~100-page cliffs; scanned >100pp or >32 MB effectively unread | HIGH | `extractFields.ts:149, 463-484`, `PDF_MAX_BYTES=32MB` |
| B3 | Text-path input clip drops the tail of long docx/xlsx/csv & vision-fallback | MED-HIGH | `extractFields.ts:147` `MAX_INPUT_CHARS=120_000`, `:454` `slice(0, …)` |
| B4 | OCR output single-blob capped at 16k, `page:null` → long scans truncated, per-page citations lost | MEDIUM | `claudeOcr.ts:65,76`; `config.ts` `OCR_MAX_TOKENS=16000` |
| B7 | Legacy binary `.doc` unread (mammoth is OOXML-only → `[]` → `unreadable`) | LOW-MED | `extract/index.ts:91-102` |
| B8 | Schema gaps (no per-row weight/origin on line_items; `unit_price`/`amount` typed string in tool vs number in TS) | LOW | `extractFields.ts:102-142, 221-222` |

### B-recall (does the right content reach the agent)

| # | Root cause | Severity | Where / value |
|---|-----------|----------|---------------|
| B5 | **Embed-fail files marked `ready` with 0 vectors → search silently blind; fallback off by default** | CRITICAL | `worker/index.ts:135-163`; `config.ts:100` `EMBEDDING_FALLBACK_PROVIDER='none'`; `embeddings/index.ts:41-51`; `voyage.ts` retry 5/30s |
| B6 | Search **top-K = 6**, global-score only, **no per-doc diversity** → one big doc starves the rest | HIGH | `tools.ts:1104`; `qdrant.ts:103,135` |
| B9 | Tool never signals scale (no "showing 6 of ~80 chunks in 12 files") → agent treats 6 chunks as the whole picture and stops | HIGH | `tools.ts:1117`; scores dropped `:1110-1116` |
| B10 | `read_file` returns ~12k chars; agent not told to paginate → reads only the head | MED-HIGH | `tools.ts:1161-1163` |
| B11 | `read_file` targets by **name only** (exact, case-insensitive, no `file_id`, no fuzzy) → a slightly wrong name = "not found" | MEDIUM | `tools.ts:79-87, 1201-1212` |
| B12 | `list_files` (the Rule-4 fallback) lacks `file_id`, `doc_type`, page count, and a truthful index-coverage flag → agent can't reliably pick/page a file | MEDIUM | `tools.ts:1173-1199` |
| B13 | Chunking doesn't carry table/section headers to continuation chunks; never crosses page boundary → wide tables split into header-less rows (search-only) | MEDIUM | `chunk.ts:12-13, 19-27` (`TARGET_CHARS=3200`, `OVERLAP=400`) |

**Positives confirmed (not bugs):** workspace scoping is correct (`qdrant.ts:105`,
no cross-tenant leak); there is **no score-threshold filter** silently dropping
hits; chunk overlap (400) exists; payload carries `file_id`/`page`/`folder` (just
not all surfaced to the agent); reading does **not** depend on embeddings.

---

## Cross-cutting synthesis — why it's felt as "bad + forgetful"

- A real shipment session hits **several of these at once**: files may be
  index-blind (B5) → search empty → agent (even with the new Rule-4 fallback) can't
  pick the right file because `list_files` lacks `doc_type`/`file_id` (B12) and
  `read_file` only returns the head (B10) → the extraction it *could* fall back on
  may itself be truncated for big tables (B1). Then across turns everything read is
  forgotten (A1), so the next question restarts the whole lossy chain.
- The recent PR #18 fixes were **input-side** (PDF spacing, OCR-by-density,
  extraction input, near-empty flag). The biggest remaining causes are
  **output-side and architecture-side**: output-token truncation (B1/B4), retrieval
  breadth (B5/B6/B9), read cap (B10), and conversation memory (A1). That's why
  quality still lags a raw chat that simply keeps the whole document in context.

---

## Prioritized fix plan

**P0 — invisible data loss (do first; each is a few-line change):**
1. **Stop marking embed-failed files as plain `ready`** — add a per-file
   `search_status`/`indexed` flag; set `unindexed` when embedding fails; surface it
   in `runSearch` ("N файлів ще не в індексі — пошук неповний") and `list_files`.
   Turn on `EMBEDDING_FALLBACK_PROVIDER=openai` in prod. (B5)
2. **`stop_reason` check in `runExtraction`** — if `max_tokens`, mark
   `partial`/`no_fields`, never `ok`; log it. (B1)
3. **Raise `read_file` `MAX`** to ~40–50k and tell the model (tool description) to
   request further `range`s when it sees `…[обрізано]`. (B10)
4. **Raise search top-K to ~20–30 + per-doc diversity** (cap chunks per `file_id`);
   include total chunk/doc counts + a "partial view" note in the result. (B6/B9)

**P1 — the two architectural levers:**
5. **Conversation memory (A1)** — persist + replay tool_use/tool_result blocks (new
   JSONB column / sibling table), plus **history windowing + input token budget**
   (A2/A4) so replay can't overflow. Pin the cacheable system prefix; consider
   prompt caching.
6. **Surface `document_extractions` as durable context (A5)** — a compact per-file
   key-field digest in a trailing system-prompt block. Cheap, and partially fixes
   A1 on its own (data survives even without block replay).
7. **Page-batch the vision extraction (B2)** — split PDFs into N-page windows,
   extract per batch, merge `line_items`; removes the 100-page/scan cliff and keeps
   each call's output within budget.
8. **Enrich `list_files`** with `file_id`, `doc_type`, page count, true index flag;
   add read-by-`file_id` + fuzzy name to `read_file`. (B11/B12)

**P2 — fidelity hardening:**
9. Multi-pass (chunk→extract→merge) for text over `MAX_INPUT_CHARS` (B3);
   per-page OCR windows with real page numbers (B4); table-header carry-over in
   chunking (B13); `.doc` conversion path (B7); widen line-item schema + fix
   string/number type mismatch (B8); checkpoint answer persistence on failure (A6);
   in-turn message-size guard (A3).

## Implementation status (branch `feat/analysis-context-fixes`)

**Constraint honoured:** no OpenAI. Embeddings stay on Voyage (Anthropic's partner);
the LLM stays on the Claude API. The blind-search fix is a coverage signal + a
read_file fallback, NOT an OpenAI fallback embedder.

**Fixed:**
- A1 memory — `messages.blocks` JSONB; `appendMessage` stores the turn's full
  Anthropic content blocks; `getConversationHistory` replays them losslessly (thinking
  stripped). The agent now remembers what it read across turns.
- A2 windowing — history replayed within a ~400k-char budget (whole turns dropped
  oldest-first), so replay can't overflow the context window.
- A5 durable context — `documentsDigest.ts` injects a per-file key-field digest into
  the system prompt every turn.
- A6 checkpoint — `runAgentTurn` no longer throws on stream error; partial text +
  turn blocks are persisted and an `error` is surfaced.
- B1 extraction truncation — output cap 16k→32k **and** `stop_reason` detection →
  status `partial` (never silently `ok`).
- B5 blind search — `search_documents` distinguishes an empty index (files present,
  0 vectors) from "nothing found" and steers to list_files + read_file; a scale note
  ("shown N of ~M") is added. (No OpenAI fallback.)
- B6/B9 recall — top-K 6→24 with per-document diversity; total-chunk scale signal.
- B10 read cap 12k→50k + explicit "paginate with range" instruction on truncation.
- B11/B12 — `read_file` accepts `file_id` + fuzzy name; `list_files` returns
  `file_id` + `doc_type`.
- B13 — chunking carries the page/table header into continuation chunks.
- B4 (partial) — OCR token budget 16k→32k (per-page numbering deferred).
- B8 — line-item `unit_price`/`amount` schema typed `number` (was `string`).

**Deferred (need a new dependency or larger work; tracked here):**
- B2 vision page-batching (splitting PDFs into page windows) — needs a PDF-split
  library; the 32k output cap + `partial` flag mitigate the common case meanwhile.
- B3 multi-pass extraction for text beyond `MAX_INPUT_CHARS` (120k) — currently the
  tail is still clipped (rare for single docs).
- B7 legacy `.doc` conversion — needs a converter; today `.doc` is flagged unreadable.
- OCR per-page page numbers (needs per-page rendering) and A3 in-turn size guard
  (low risk given the history budget + opus context).

## Open questions for the owner (max 5)
1. **Conversation memory approach:** full tool-block replay (lossless, heavier
   context/cost) vs a per-turn extraction/read carry-over summary (cheaper, lossy)?
   Recommend full replay + windowing.
2. **Embedding reliability:** enable the OpenAI fallback embedder in prod
   (needs a key), or accept Voyage-only and just surface the blind-index state?
3. **read_file / search budgets:** target read cap (~50k?) and top-K (~25?) —
   acceptable on latency/cost for opus?
4. **Vision page-batching window** (5 or 10 pages) and max pages per file before we
   ask the user to split?
5. **`.doc` policy:** add a server-side conversion, or reject with a "convert to
   .docx/PDF" message?
