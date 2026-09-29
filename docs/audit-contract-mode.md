# Audit — Two-party vs Three-party contract logic in Shturman

**Status:** read-only audit. No code changed. This document is the only file written.
**Date:** 2026-09-29
**Scope:** how the app determines and uses the import contract structure
(two-party `Supplier → AGroup95` vs three-party `Supplier → PrimeForce → AGroup95`),
and what it takes to add: manual override precedence, auto-detection with confidence,
an interactive 10-question survey (Claude-style question cards), and mode-aware analysis.

> **Terminology note (important).** The business brief uses `two_party` / `three_party`.
> The codebase already uses **`contract_type ∈ ('bilateral','trilateral')`** for the same
> concept (`bilateral` = two-party, `trilateral` = three-party). This audit recommends
> **reusing `contract_type`** as the single source of truth and adding companion
> `_source` / `_confidence` columns, rather than introducing a parallel `contract_mode`
> column that would split the source of truth. Throughout this doc, `bilateral ⇔ two_party`
> and `trilateral ⇔ three_party`.

---

## 1. Executive summary

- **The 2/3-party concept already exists and is load-bearing.** It is
  `workspaces.contract_type ∈ ('bilateral','trilateral')`, with a deterministic
  auto-derivation engine (`partyExtraction.ts`), a sidebar selector +
  "apply suggestion" UI (`ShipmentPanel.tsx`), a `/suggest` endpoint, a checklist
  dimension, and an agent intake tool. **This is an extension, not a greenfield build.**
- **What's missing:** (1) no persisted **confidence** or **source** for the mode — the
  reason string is computed per-request and thrown away; (2) **no "manual override wins"
  guard** — auto and manual both write `contract_type`, last-write-wins; (3) **no survey /
  question-card** mechanism — chat messages are text-only, no structured payload;
  (4) reconciliation is **single-invoice / single-seller** — it has no trilateral
  (two-invoice-leg, intermediary-aware) checks; (5) the trilateral required-docs list is a
  **placeholder** (`intermediary_agreement`).
- **Biggest risks:** silent overwrite of a user's manual mode by auto-detection (no lock
  flag, no versioning on `workspaces`); the **frozen, cache-optimized system prompt**
  (only `number`/`supplier` interpolated) — survey/mode context must be injected via a
  trailing block or a tool, not mid-prompt; and the `intake_complete` recompute is
  **duplicated in 3 places**, so any change to the required-field set must edit all three.
- **Verification constraint:** no local dev env (production only). Almost everything below
  is **typecheck/build-verifiable** (`npm run typecheck`, `npm run build`, frontend `tsc`);
  live agent behaviour, SSE streaming, and worker paths can only be smoke-tested against a
  running stack.

---

## 2. Findings per area

### A. Current state of contract-mode logic

Canonical value set is `'bilateral' | 'trilateral'`. The literals `two_party`/`three_party`
do **not** appear in code. Internal companies are `AGroup95` / `PrimeForce`.

Backend (load-bearing):
- `src/db/schema.sql:125-126` — `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS contract_type TEXT CHECK (contract_type IN ('bilateral','trilateral'));`
- `src/db/schema.sql:237-250` — checklist `contract_type` dimension + guarded trilateral seed row (`intermediary_agreement`, placeholder).
- `src/services/partyExtraction.ts:10-17, 40-44, 193-231` — the bilateral/trilateral decision engine (see area B).
- `src/services/parties.ts:14, 35, 103-129` — three fixed party slots; `INTERNAL_COMPANIES = ['AGroup95','PrimeForce']` (`:35`); `validateParties(contractType, …)` soft-warns on slot/count mismatch (`:116-121`).
- `src/services/checklist.ts:41-52` — checklist template match includes `contract_type` (`:47`).
- `src/routes/parties.ts:36, 48-56` — `validateParties(ws.contract_type,…)` and `/suggest` returns `suggested_contract_type` + `contract_type_reason`.
- `src/routes/workspaces.ts:194, 269, 305` — patch/intake set `contract_type`; `intake_complete` requires it among the five.
- `src/services/workspaceAccess.ts:29` — `WorkspaceRow.contract_type: 'bilateral' | 'trilateral' | null`.
- `src/services/report.ts:187, 195` — renders "Тип контракту" in the HTML report.
- `src/agent/tools.ts:137-145, 628-647` — `save_workspace_context` exposes `contract_type` enum `['bilateral','trilateral']`.

Frontend:
- `frontend/lib/types.ts:24` — `contract_type?: "bilateral"|"trilateral"|null`.
- `frontend/components/ShipmentPanel.tsx:427-465` — the select (Двосторонній/Тристоронній) + auto-suggest + "Застосувати" apply block (**this is the mode selector today**).
- `frontend/components/ShipmentPanel.tsx:226-232` — `SuggestResponse` carries `suggested_contract_type` + `contract_type_reason`.
- `frontend/components/ShipmentPanel.tsx:563-564` — the **intermediary party slot is only rendered when `contract_type === "trilateral"`**.

Design intent / open TODOs:
- `docs/sidebar-enhancement/phase-4-action-prompt.md:32-46, 51-71, 74-85` — the original "2/3-party logic + docs checklist" spec, incl. explicit TODO to confirm the real trilateral required-doc list with the domain owner.
- `docs/sidebar-enhancement/00-audit-and-plan.md:86-100` — notes `party_count` is **not stored** (derived from `contract_type`).

**Missing:** no `contract_type_source`, no `contract_type_confidence`, no persisted reason,
no override lock, no survey.

### B. Party / role extraction

Two distinct layers:

**(a) Per-document LLM extraction — `src/services/extraction/extractFields.ts`.**
Single forced-tool Claude call (`record_extraction`, `tool_choice` forced, `:429-441`).
Model from `src/anthropic/client.ts`. Vision path feeds the original PDF/image
(`extractDocumentFieldsFromDocument`, `:459-480`); text path `:449-452`.
Schema is **hand-written JSON Schema** (`EXTRACTION_TOOL.input_schema`, `:151-268`) — **not
Zod** — with a hand-rolled `normalize()` (`:357-390`); TS interface `ExtractedFields`
(`:102-142`) is the extensible backbone (only `doc_type` is required). Party-relevant shape:

```ts
export interface ExtractedParty {            // :84-89
  name: string; role: string | null; country: string | null; address: string | null;
}
// on ExtractedFields (:102-142):
buyer: string | null;          // :116
seller: string | null;         // :117
manufacturer: string | null;   // :122  ← KEY signal for bilateral/trilateral
registration_number: string | null; // :123
country_of_origin: string | null;    // :115
parties: ExtractedParty[];     // :130  ← free-text role[] per document
field_confidence: {...}        // :245-258 per-field high/medium/low
```

**(b) Deterministic mode derivation — `src/services/partyExtraction.ts`.**
Makes **no** LLM call; a pure function over stored `document_extractions` (`:102-108`).
Core logic (`:193-228`):

```
manufacturer == invoice seller       → BILATERAL   (maker sells direct)   :197-201
manufacturer != invoice seller       → TRILATERAL  (middleman)            :202-210
seller present, manufacturer absent  → null  (role "уточнюється")         :216-224
neither                              → null  ("Недостатньо даних")        :225-227
```

Buckets `manufacturer`/`seller`/`buyer` scalars **and** classified `parties[]` (regexes
`MANUFACTURER_RX`/`SELLER_RX`/`BUYER_RX`, `:77-79`), picks most-corroborated candidate
(`pickTop`, `:90-96`), outputs `PartiesAnalysis { suggestions[], contract_type,
contract_type_reason }` (`:38-44`). Each `PartySuggestion` carries `source_files[]`,
`confidence` (0..1 = corroboration/totalDocs, `:172`), `from_field`, `uncertain_role?`.
`decideParties()` is exported pure for unit testing (`:165`).

**Strongest signal for mode detection:** the **invoice** (`seller`, `buyer`, `total_value`,
`currency`, `incoterm`) compared against any doc naming the **manufacturer** (COA / quality
certificate / label). The whole verdict hinges on `manufacturer` vs `seller`; packing list
and customs declaration mostly corroborate. **Schema is extensible** — a `parties[]` role
enum and a `related_invoice_leg` hint could be added to `EXTRACTION_TOOL.input_schema`.

### C. Right sidebar (Постачання / Комплектність / Журнал)

- Shell: `frontend/components/RightPanel.tsx:8-12` — 344px `<aside>`, tabs `Файли / Журнал /
  Комплектність`; purely presentational, editing UI passed in as the `complete` prop.
- Wired at `frontend/app/workspaces/[id]/page.tsx:1287-1313` (rendered only when
  `rightOpen && view==="chat" && chatKind==="supply"`); `:1311` passes
  `<ShipmentPanel workspaceId={id} workspace={workspace} onPatch={onPatch} />`.
- **`frontend/components/ShipmentPanel.tsx`** is the real panel. **State = local React
  `useState` only** (no SWR/context). Loads via raw `api()` client: `/api/users`,
  `/api/workspaces/:id/parties` (`:131`), `/risks` (`:137`), `/checklist` (`:141`).
  Mutations: `/intake` PATCH (`:177`), `/status` PATCH (`:195`), `/api/workspaces/:id` PATCH
  (`:206`), `/parties` POST (`:214`), `/parties/suggest` POST (`:236`).
- Fields edited: status, **contract_type (select, `:427-436`)**, product_category,
  **incoterm_in / incoterm_out (`:469-491`)**, transport_mode, origin/destination country,
  responsible user, three party slots `sender`/`intermediary`/`recipient` (`:559-642`).

**Where the Auto / Two-party / Three-party selector + confidence badge fits:** it *already
exists in embryonic form* at `ShipmentPanel.tsx:427-465`. The reason/suggestion block
(`:437-465`) is the natural **confidence badge slot** — already fed by the backend
`suggested_contract_type` + `contract_type_reason`. The change is: add an **"Auto" option**
(empty value that defers to the suggestion), render a **confidence badge** (needs a numeric
`contract_type_confidence` from the backend — today the decision is qualitative), and make
a manual pick set `contract_type_source='manual'` so auto never overwrites it.

**Locked-requirements ↔ current code:** "flexible party roles" is **built** (`parties.role`
is free-text since `schema.sql:235` dropped the CHECK; `canonicalRole` normalizes,
`parties.ts:55-63`). Incoterms **built** (`incoterm_in`/`incoterm_out`, dual selects).
Countries **built** (origin/destination Combobox). "2/3-party auto-detect + manual override"
is **half-built**: auto-detect + apply-button exist; **persisted confidence/source and the
override guard do not**.

### D. Interactive question cards in chat

- **Message model — `frontend/lib/types.ts:255-262`:**
  ```ts
  export interface Message {
    id: string; role: "user" | "assistant"; content: string;
    citations?: Citation[]; tool_calls?: ToolCall[]; created_at?: string;
  }
  ```
  Strictly text (`content: string`). **A persisted message cannot carry a structured
  payload today** — no `type` discriminator, no `options`.
- **But the FE already has the exact pattern to extend:** `Chat.tsx:145`
  `type ChatItem = ({ kind: "message" } & Message) | ClassifyCard;`. `ClassifyCard`
  (`:128-143`) is a non-text, **button-bearing interactive card** rendered inline
  (`ClassifyBubble`, `:1256-1351`, folder-choice buttons at `:1327-1348`). **This is the
  direct precedent for a question card** — add a third union arm `QuestionCard`. It is
  local-only (not persisted), which matches a survey that round-trips answers as messages.
- **SSE — `frontend/lib/sse.ts`:** SSE-over-POST via `fetch`+`ReadableStream`; events parsed
  `:83-99`: `token`, `tool_call`, `tool_result`, `done`, `error` (types `lib/types.ts:271-291`).
  Consumed in `Chat.tsx:446-487`. **No structured-card event exists.**
- **Quick-reply reuse:** (1) `ClassifyBubble` folder buttons (`Chat.tsx:1327-1348`) — best
  model, reuse `.btn` styling; (2) empty-state starter chips (`:738-760`, `STARTERS`
  `:834-839`) call `runMessage(text)` — the simplest "click → send message" path, **ideal
  for survey answer buttons**; (3) `sort-inbox` bulk action (`page.tsx:461-473`) — server-side,
  not per-message.
- **Paperclip button:** **fully wired, not dead.** `Chat.tsx:1121-1145` (`data-testid=
  "chat-attach"`), `onClick={onAttach}`; `attachAction` (`:532-536`): in **supply** chat opens
  file input → stage + auto-classify; in **consolidated** opens manifest picker; in **normal**
  chat `onAttach` is `undefined` so the button isn't rendered. (The brief's "dead paperclip"
  is only true in normal chat.)
- **How a clicked option returns to backend:** the only chat→backend path is a **normal
  user-message POST** streamed via `streamChat` (`Chat.tsx:446`), endpoint from
  `resolveChatEndpoints` (`lib/chatContext.ts:26-55`): supply → `POST /api/workspaces/:id/chat`.
  **Least-invasive = call `runMessage(answerText)`** (exactly what starter chips do). No new
  endpoint, no message-model change. *(This matches your chosen answer: option = normal chat
  message.)*
- **i18n:** **no i18n library.** All UI text is hardcoded **Ukrainian** inline; enum→label
  maps are module-level `const Record` objects (e.g. `STATUS_OPTIONS` `ShipmentPanel.tsx:42-49`,
  `FOLDER_LABELS` `lib/folderLabels.ts`). **Survey question/option text should follow this
  pattern** — a module-level `const` map (e.g. `lib/surveyQuestions.ts`), UA-only.

### E. Agent / tool layer

- Tool defs: `toolDefinitions` (`tools.ts:56-251`), `logistToolDefinitions` (`:261-346`,
  gated on `LOGIST_MCP_URL`). Handler shape `ToolOutcome = { result, summary, citations }`
  (`tools.ts:46-53`). Dispatch `executeTool` switch (`:362-413`); `ToolContext =
  { workspaceId?, collectionId?, ownerId? }`; `requireWorkspace(ctx)` narrows/throws.
- 15 shipment/collection tools incl. read tools (`search_documents`, `read_file`,
  `list_files`, `get_checklist`, `get_discrepancies`, `get_risks`, `get_missing_context`)
  and **write tools** (`save_workspace_context`, `classify_and_file`, `sort_inbox`,
  `normalize_shipment_files`, `generate_report`).
- **`sort_inbox` is the mirror pattern for new tools** — def (`tools.ts:192-198`), dispatch
  (`:390-391`), handler `runSortInbox` (`:779-797`, empty `input_schema`, returns a
  human-readable `result` list + `summary`). A new tool needs only: append a `ChatTool`,
  add a `case`, write a `run…` handler. **No change in `chat.ts`** (it spreads
  `...toolDefinitions`).
- **Write pattern to mirror for `set_contract_mode`** = `save_workspace_context` →
  `runSaveContext` (`tools.ts:649-708`): Zod-validate (`saveContextSchema` `:628-647`) →
  `getWorkspaceById(requireWorkspace(ctx))` → whitelisted dynamic `UPDATE workspaces` over a
  fixed `scalarKeys` list → recompute `intake_complete` → `refreshWorkspaceState`.
- **System prompt injection — `src/agent/systemPrompt.ts`.** `buildSystemPrompt` receives
  **only `{ number, supplier }`** (`:70-73`); the prompt is **deliberately frozen for prompt
  caching** (docstring `:62-69`). Two existing trailing extension blocks: `userPortraitBlock()`
  (`:10-21`) and `logistToolsPromptBlock()` (`:31-60`), spread at the end (`:148-149`).
  **To inject contract_mode + survey answers:** either (a) widen the param and add a
  **trailing** dynamic block (keeps the cacheable prefix intact) passing fields from
  `chat.ts:48-56`, or (b) expose a `get_contract_mode` tool and leave the prompt frozen.
  **Do not** insert per-shipment data mid-prompt.
- **Context gate (`get_missing_context`)** — grounding Rule 1 (`systemPrompt.ts:86-92`):
  before instruction/discrepancies/HS-code/report, the model must call `get_missing_context`
  and, if anything is unset, **ask and stop**. The survey is the interactive way to satisfy
  exactly this.

### F. Analysis plan generation

There is **no explicit "plan" object**, but there are **two deterministic cross-doc engines**,
both reading only `document_extractions`:

- **Checklist (completeness) — `src/services/checklist.ts`.** Requirements from
  `checklist_templates` matched on `product_category / incoterm(_in) / transport_mode /
  contract_type` with **NULL = wildcard** (`:41-52`); statuses `missing`/`received`/`verified`.
  Baseline seed (`schema.sql:220-225`): `invoice, packing_list, certificate_of_origin,
  quality_certificate, customs_declaration, transport`. **Trilateral row exists but is a
  placeholder** (`intermediary_agreement`, `schema.sql:247-250`, NOTE(phase4) to confirm with
  domain owner).
- **Discrepancies / reconciliation — `src/services/discrepancies.ts` → `reconcile.ts`.**
  Pure `reconcile(docs)` (`reconcile.ts:121-305`), findings ranked `confirmed`🔴 / `suspected`🟡.
  Current checks: weight net/gross/total invoice↔packing (`:135-142`), package count
  (`:145-156`), currency invoice↔contract (`:159-172`), total value 0.5% same-currency
  (`:176-196`), HS-code presence/agreement (`:199-223`), country of origin (`:226-236`),
  incoterm invoice↔contract (`:239-250`), **party seller/buyer invoice↔contract only**
  (`crossCheckParty` `:254, 359-382`, always 🟡), manufacturer+reg-number across docs
  (`:260-261, 400-438`), line items ≤5 (`:263-265, 440-529`), missing-counterpart/duplicate
  notes (`:270-302`).

**What must differ for trilateral (Supplier→PrimeForce→AGroup95):**
1. **Two invoice legs.** `pick(docs,'invoice')` (`reconcile.ts:82-94`) takes only the first
   invoice; a second is currently emitted as a *duplicate warning* (`:270-282`). Trilateral
   needs to split **inbound** (Supplier→Prime) vs **outbound** (Prime→AGroup95) and reconcile
   each leg.
2. **Intermediary party axis.** `crossCheckParty` only compares seller/buyer invoice↔contract;
   there is no PrimeForce/intermediary leg check, though the `intermediary` slot exists.
3. **Incoterm split.** `workspaces` already has `incoterm_in`/`incoterm_out`; reconcile still
   compares a single `incoterm` (`:239-250`).
4. **Value chain / markup.** The value check assumes legs *must match* (`:176-196`); trilateral
   legs legitimately differ (markup, possibly different currency) → current logic would
   false-positive. Needs a "markup expected, not a discrepancy" branch.
5. **Required docs.** Real trilateral doc list is an open TODO (`intermediary_agreement`
   placeholder).

### G. Data model

**`workspaces` full columns.** Base (`schema.sql:29-37`): `id UUID PK`, `owner_id UUID FK`,
`number TEXT`, `supplier TEXT`, `status TEXT` (widened `:213-216`), `created_at`. Added via
idempotent `ALTER … ADD COLUMN IF NOT EXISTS`: `contract_type` (`:125-126`), `intake_complete`
(`:127`), `product_category` (`:128`), `incoterm` legacy (`:129`), `transport_mode` (`:130`),
`origin_country` (`:131`), `responsible_user_id` (`:133-134`), `destination_country` (`:231`),
`incoterm_in`/`incoterm_out` (`:284-285`).

**Migration convention.** **Single idempotent `schema.sql`, no numbered migrations.**
`src/db/migrate.ts:10-14` runs the whole file on boot. Everything is `CREATE TABLE IF NOT
EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` / guarded `INSERT … WHERE NOT EXISTS`,
appended under dated "phase" comment banners. JSONB is the precedent for structured blobs
(`parties.contact_info`, `document_extractions.extracted_fields`).

**Proposed additions (do NOT create — proposal only), appended as a new dated phase banner:**

```sql
-- ── Phase (contract-mode + survey) ─────────────────────────────
-- Persist detection provenance. contract_type stays the source of truth
-- (bilateral = two_party, trilateral = three_party).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS contract_type_source     TEXT
  CHECK (contract_type_source IN ('sidebar','survey','auto'));   -- who set it; sidebar/survey = manual = locked
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS contract_type_confidence REAL;      -- 0..1, only meaningful when source='auto'
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS contract_type_reason     TEXT;      -- persisted human-readable reason (today thrown away)

-- Survey state (one row per shipment; JSONB answers keyed by question id).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS survey_answers  JSONB;              -- { q1: {...}, q2: {...}, ... }
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS survey_status   TEXT
  CHECK (survey_status IN ('not_started','in_progress','completed','skipped'))
  DEFAULT 'not_started';
```

Rationale for reusing `contract_type` instead of a new `contract_mode`: a parallel column
would split the source of truth across the sidebar (`contract_type`), checklist matching
(`contract_type`), reconcile, report, and `get_missing_context` — all already keyed on
`contract_type`. The **override lock** is expressed by `contract_type_source`: `sidebar` or
`survey` ⇒ manual ⇒ auto-detection must **not** overwrite (mirrors the file `folder_id IS
NULL` guard in `worker/index.ts:217`). If a JSONB blob feels too loose, `survey_answers` can
later be normalized to a `shipment_survey_answers` table — but JSONB matches the repo's
existing convention and needs no join.

### H. Risks

- **Manual-override vs auto-detection race (the headline risk).** Manual writes:
  `PATCH /api/workspaces/:id` (`workspaces.ts:205-246`) and `/intake`
  (`workspaces.ts:280-321`). Auto write: agent `runSaveContext` (`tools.ts:649-708`).
  `workspaces` has **no versioning / optimistic concurrency → last write wins**, and there is
  **no "manually set, don't auto-touch" flag** for the mode. → **Mitigation:** the proposed
  `contract_type_source` guard; auto-detection must check it and refuse to overwrite
  `sidebar`/`survey`.
- **`intake_complete` recompute duplicated in 3 places** — `workspaces.ts` PATCH,
  `workspaces.ts` `/intake` (`:304-312`), and `tools.ts:686-696`. Any change to the required
  set touches all three (a known footgun; keep the required set unchanged if possible).
- **Frozen system prompt** (`systemPrompt.ts:62-69`) — cache-optimized; inject via trailing
  block or tool only.
- **Dedup / content_hash** (`storage.ts:64-66`, `files.ts:139-196`): not mode-dependent, so
  contract-mode won't corrupt dedup. But if a survey/detection triggers a **re-index sweep**
  concurrently with an in-flight upload batch, you get duplicate (harmless) LLM classification
  work (`files.ts:451-455`). No transactional lock around detect+write.
- **Classify/folders not mode-aware** (`classify.ts:18-27`, `domain/folders.ts:11-18`) — the
  folder skeleton is fixed. If trilateral requires a distinct "intermediary invoice" folder,
  both the skeleton and `DOC_TYPE_TO_FOLDER` need changes (out of scope for a first slice —
  keep both invoices in the existing invoice folder, distinguish by extraction leg).
- **Worker best-effort** (`worker/index.ts:102-231`) — embeddings/extraction/auto-file/risk
  are all try/catch best-effort; auto-file guarded on `folder_id IS NULL`. **Chosen approach
  avoids the worker entirely** (detection on-demand via agent tool), which sidesteps this.
- **Multi-tenant scoping** (`workspaceAccess.ts:46-66`): agent tools use
  `getWorkspaceById` (no ownership check) safely **only because** the route already ran
  `getOwnedWorkspace` (`chat.ts:34`). **Any new REST endpoint for contract-mode must call
  `getOwnedWorkspace`, not `getWorkspaceById`.** New `contract_type_*` / `survey_*` columns
  auto-appear on `WorkspaceRow` (it is `SELECT *`) but must be added to the TS interface
  (`workspaceAccess.ts:21-39`).
- **Verification (prod-only env):** data model, routes, tools, FE components, survey config,
  and reconcile changes are all **typecheck/build-verifiable**. Not verifiable without a live
  stack: agent tool-calling behaviour, SSE question-card round-trip, the auto-detection
  confidence in practice, and worker interactions.

---

## 3. Proposed architecture

### Precedence (resolution order, evaluated on read + on write-attempt)
1. **Manual override (sidebar Постачання panel)** — `contract_type_source ∈ {'sidebar'}`.
   Always wins.
2. **User-confirmed survey answers** — `contract_type_source = 'survey'`. Wins over auto.
3. **Auto-detection** — `contract_type_source = 'auto'`, with `contract_type_confidence`.
4. **`unknown` / low confidence → run the survey** (ask the user).

**The lock rule:** auto-detection may write `contract_type` **only if** the current
`contract_type_source` is null or `'auto'`. Manual (`sidebar`/`survey`) is never overwritten
by auto. Sidebar and survey may overwrite each other (both are the user); the later one wins
and sets its own source.

### Detection pipeline (on-demand, per your choice)
- A new agent tool **`get_contract_mode`** (read) runs the existing
  `partyExtraction.decideParties()` over stored extractions and returns
  `{ contract_type, confidence, reason, source }`. **No worker changes.**
- **`set_contract_mode`** (write) persists `contract_type` + `contract_type_source` + reason
  (+ confidence when auto), mirroring `runSaveContext` (whitelisted UPDATE + guard against
  overwriting a manual value), then `refreshWorkspaceState`.
- The existing `/parties/suggest` route already computes the suggestion; extend it to also
  return a **numeric confidence** (derive from `PartySuggestion.confidence` / corroboration)
  and, if desired, persist `contract_type='auto'` when currently unset.

### Survey flow
- Trigger surfaces (all four you selected): a **"Опитування" button** in the composer /
  Постачання panel; a **chat command** (e.g. the user typing "почни опитування" or a
  slash-chip); **auto-offer** when `get_missing_context` shows unset fields or mode is
  unknown/low-confidence; and always **manual**. Non-blocking and resumable via
  `survey_status` + `survey_answers`.
- Rendering: a new `QuestionCard` arm on `ChatItem` (`Chat.tsx:145`), modeled on
  `ClassifyCard`/`ClassifyBubble`, reusing `.btn` option styling. One question per card,
  3–4 options + optional free-text "Інше".
- Answer round-trip (**your choice: normal chat message**): clicking an option calls
  `runMessage(answerText)` → same `/api/workspaces/:id/chat` SSE endpoint. The agent reads the
  answer, calls `save_workspace_context` / `set_contract_mode` / `upsertParties`, and emits the
  next question as the next card. No new endpoint, no message-model change.
- Persistence: answers written to `survey_answers` JSONB and **synced to the existing sidebar
  fields** (contract_type, incoterm_in/out, transport_mode, origin/destination, parties) via
  the existing `save_workspace_context` write path — so sidebar ↔ survey stay in sync both ways.

### Sidebar integration
- Upgrade the `contract_type` control (`ShipmentPanel.tsx:427-465`) to **Auto / Двосторонній /
  Тристоронній**, where "Auto" defers to the persisted auto value and shows a **confidence
  badge** (green ≥0.8, amber 0.5–0.8, grey <0.5). A manual pick sets `contract_type_source=
  'sidebar'` (via the existing `/intake` or `/workspaces` PATCH) → auto stops overwriting.
- Add a small "Пройти опитування" button that triggers the chat survey.

### Agent tools (new)
| Tool | Kind | Purpose | Mirrors |
|---|---|---|---|
| `get_contract_mode` | read | run detection, return mode+confidence+reason | `get_missing_context` |
| `set_contract_mode` | write | persist mode + source(+conf), honor lock | `save_workspace_context` |
| `run_shipment_survey` | orchestration | drive the 10-question flow (emit next card as answer, write via save_workspace_context) | `sort_inbox` + `get_missing_context` loop |

System-prompt: add a **trailing** dynamic block (like `logistToolsPromptBlock`) summarizing
current `contract_type`, source, confidence, and `survey_status`; pass from `chat.ts:48-56`.
Keeps the cacheable prefix frozen.

### Analysis plan (mode-aware)
`get_contract_mode`'s result branches the checks:
- **two-party:** current single-invoice reconcile (unchanged).
- **three-party:** split invoices into inbound/outbound legs, reconcile each leg, add
  intermediary-party check, use `incoterm_in`/`incoterm_out`, treat inter-leg value delta as
  **expected markup** (not a discrepancy), and extend the trilateral checklist required-docs.

---

## 4. Draft — 10 survey questions (Ukrainian)

One question per card, 3–4 options + optional free-text "Інше". Default assumed product form
is **"substance/АФІ"** per the user portrait. Each question notes the sidebar field /
analysis-plan decision it feeds.

1. **Яка структура контракту цього постачання?**
   - Постачальник → AGroup95 (прямий імпорт)  → `contract_type='bilateral'`
   - Постачальник → PrimeForce → AGroup95 (через посередника)  → `contract_type='trilateral'`
   - Ще не знаю / нехай визначить система  → keep `auto`
   - Інше
   *Feeds:* `contract_type` (+ source=survey); decides two-leg vs one-leg analysis.

2. **Хто виставляє інвойс кінцевому покупцю (AGroup95)?**
   - Виробник напряму
   - Торговий постачальник (не виробник)
   - PrimeForce
   - Інше
   *Feeds:* seller party + reinforces bilateral/trilateral (manufacturer≠seller ⇒ trilateral).

3. **Хто вантажовідправник (consignor) і хто вантажоодержувач (consignee)?**
   - Відправник = постачальник, одержувач = AGroup95
   - Відправник = постачальник, одержувач = PrimeForce
   - Відправник = PrimeForce, одержувач = AGroup95
   - Інше
   *Feeds:* `parties` slots (sender/intermediary/recipient); reconcile party axis.

4. **Хто платник за товар / за перевезення?**
   - AGroup95 платить постачальнику напряму
   - AGroup95 платить PrimeForce; PrimeForce платить постачальнику
   - Розділено (товар — один, перевезення — інший)
   - Інше
   *Feeds:* value-chain / markup logic; confirms number of commercial layers.

5. **Чи відрізняються ціни між наборами документів (Supplier→Prime та Prime→AGroup95)?**
   - Так, є націнка (різні суми)
   - Ні, ціни однакові
   - Лише один набір документів
   - Не знаю
   *Feeds:* markup-expected branch in reconcile (suppresses false value-mismatch).

6. **Які умови постачання (Incoterms) і на якому плечі?**
   - Одні умови на все постачання
   - Різні: вхідні (Supplier→Prime) та вихідні (Prime→AGroup95)
   - Ще не визначено
   - Інше
   *Feeds:* `incoterm_in` / `incoterm_out`; incoterm-split checks.

7. **Який вид транспорту та маршрут (звідки → куди)?**
   - Авто
   - Море
   - Авіа
   - Залізниця / комбінований
   *Feeds:* `transport_mode`, `origin_country`/`destination_country`; checklist transport docs.

8. **У якій формі товар?** (за замовчуванням припускаємо «субстанція/АФІ»)
   - Субстанція (АФІ)
   - Готовий продукт
   - In-bulk / напівфабрикат
   - Обладнання / інше
   *Feeds:* `product_category`; HS-code path, required certs (drives УКТЗЕД/dual-use checks).

9. **Чи залучені брокер / експедитор?**
   - Так, митний брокер
   - Так, транспортний експедитор
   - І брокер, і експедитор
   - Ні
   *Feeds:* extra `parties` roles; checklist (transit/forwarding docs).

10. **Що перевірити першочергово?**
    - Комплектність документів
    - Розбіжності інвойс/пакувальний/контракт
    - Класифікація УКТЗЕД / дозвільні документи
    - Терміновість — усе одразу
    *Feeds:* analysis-plan ordering (which check runs first); urgency/priority.

*(Free-text "Інше" on every card is captured in `survey_answers` and surfaced to the agent.)*

---

## 5. Phased implementation plan

Per your choice, this is one coherent vertical slice, but split into independently
shippable, typecheck-verifiable phases so each can land and be reviewed on its own.

**Phase 1 — Data model + provenance + override lock.**
Files: `src/db/schema.sql` (append the Phase banner from §G), `src/services/workspaceAccess.ts`
(add `contract_type_source`/`_confidence`/`_reason`/`survey_answers`/`survey_status` to
`WorkspaceRow`), `src/routes/workspaces.ts` (accept `contract_type_source` on PATCH/intake;
set `'sidebar'` on manual edits), `src/services/parties.ts` (persist reason/confidence in
`/suggest` path if desired). Verify: `npm run typecheck && npm run build`, `npm run migrate`.

**Phase 2 — Sidebar selector (Auto / 2 / 3) + confidence badge + lock.**
Files: `frontend/components/ShipmentPanel.tsx` (add Auto option, confidence badge, set
source=sidebar on pick), `frontend/lib/types.ts` (extend `Workspace`/`SuggestResponse` with
`contract_type_confidence`/`source`). Verify: frontend `tsc`, build.

**Phase 3 — Auto-detection tools (`get_contract_mode`, `set_contract_mode`).**
Files: `src/agent/tools.ts` (2 defs + 2 handlers mirroring `save_workspace_context`, honoring
the source lock), `src/agent/systemPrompt.ts` (trailing contract-mode block), `src/routes/chat.ts`
(pass fields into `buildSystemPrompt`). Verify: typecheck/build; smoke against running stack.

**Phase 4 — Question-card component + survey config.**
Files: `frontend/components/Chat.tsx` (new `QuestionCard` arm on `ChatItem`, `QuestionBubble`
modeled on `ClassifyBubble`, click → `runMessage`), `frontend/lib/surveyQuestions.ts` (new,
the 10 questions from §4, UA-only const map). Verify: frontend `tsc`, Playwright e2e if present.

**Phase 5 — Survey orchestration + persistence + triggers.**
Files: `src/agent/tools.ts` (`run_shipment_survey` orchestration tool; writes via
`save_workspace_context`/`upsertParties`, updates `survey_status`/`survey_answers`),
`src/agent/systemPrompt.ts` (rule: offer survey when mode unknown / context missing),
`frontend/components/Chat.tsx` + `ShipmentPanel.tsx` (the "Опитування" button + command),
`frontend/app/workspaces/[id]/page.tsx` (wire trigger). Verify: typecheck/build; live smoke.

**Phase 6 — Mode-aware analysis plan.**
Files: `src/services/reconcile.ts` (two-leg invoice split, intermediary party check,
incoterm_in/out, markup-expected branch), `src/db/schema.sql` (real trilateral required-docs
once confirmed by owner), `src/services/checklist.ts` (if new required docs). Verify:
typecheck/build + unit tests on the pure `reconcile`/`decideParties`.

---

## 6. Open questions for the product owner

1. **Trilateral required documents** — the checklist row is a placeholder
   (`intermediary_agreement`). What is the real required-doc set for a three-party shipment
   (both invoice sets? intermediary contract? re-export/transit docs?)? (Blocks Phase 6.)
2. **Confidence thresholds** — at what auto-confidence should Shturman (a) silently apply the
   mode vs (b) proactively offer the survey? Proposed default: apply ≥0.8, offer survey <0.5,
   show "перевірте" 0.5–0.8. OK?
3. **Survey persistence granularity** — JSONB `survey_answers` on `workspaces` (simple, matches
   repo convention) vs a normalized `shipment_survey_answers` table (queryable/analytics). Any
   reporting need that requires the table now?
4. **Survey completion side-effects** — should finishing the survey auto-run the analysis plan
   (checklist + discrepancies + report), or only fill fields and let the user trigger analysis?
5. **Free-text "Інше"** — should free-text answers be allowed to *override* a structured field
   (agent parses them), or only stored as notes for the human? (Affects grounding-rule safety.)
