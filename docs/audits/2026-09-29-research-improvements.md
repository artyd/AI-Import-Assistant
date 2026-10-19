# Research — 3 production problems: survey→sidebar, over-asking, reading/effectiveness

**Date:** 2026-09-29 · **Type:** investigation + proposed fixes (no code changed here).
Based on three focused read-only code investigations. File:line refs are indicative
of the current tree.

## Executive summary

- **Problem 1 — survey didn't update the sidebar.** Two compounding causes: (a) the
  supply chat has **no `onTurnComplete`**, and `ShipmentPanel` loads its data **once**,
  so nothing re-fetches after the survey turn — guaranteed stale UI; (b) the survey
  sends the agent only **UA text labels** (not the machine `value`), and never collects
  Incoterm codes / countries / company names, so several fields can't be filled even
  after a reload.
- **Problem 2 — too many questions / want autopilot.** Auto-detection (parties,
  contract_type, Incoterms, origin) **already exists but is never persisted** to the DB
  (worker doesn't call it; frontend applies it only to local state). So
  `get_missing_context` keeps seeing empty fields, and the **hard-stop Rule 1** blocks
  actions and interrogates the user. The gate is also over-broad (one 6-field gate for
  4 different actions).
- **Problem 3 — files misread + "raw ChatGPT is better".** Ingestion silently
  degrades (PDF text glued without spaces; OCR only fires on *zero* text; near-empty
  vision extraction still marked `ok`; extraction capped at 4096 tokens). The agent is
  hard-capped (`max_tokens: 4096`, 8 iterations) and over-grounded (must use tools,
  "no free reasoning", hard-stop gate, no search→read fallback), so it truncates and
  deflects where a raw chat just answers.

**Keystone fix:** auto-persist document-derived intake/parties in the worker (Problem 2
step A). It simultaneously makes the sidebar populate automatically (helps #1), shrinks
the survey and stops the nagging (#2). Combined with the P0 model/ingestion fixes for
#3, these address all three complaints.

---

## Problem 1 — Survey answers don't reach the right sidebar

### Root cause (ranked)
1. **Sidebar never re-fetches after a chat turn (certain).** The supply `<Chat>` is
   mounted WITHOUT `onTurnComplete` (`frontend/app/workspaces/[id]/page.tsx:1281-1308`;
   contrast the consolidated chat which passes `onTurnComplete={reloadLatestAnalysis}`,
   `:1233`). `ShipmentPanel` loads parties/risks/checklist once in a `useEffect` keyed
   on `workspaceId` (`ShipmentPanel.tsx:137-156`) and seeds the intake form once on
   `workspace.id` (`:125-135`). So even correct DB writes are invisible until a full
   reload.
2. **Only labels reach the agent (high, contributory).** `answerQuestion` stores
   `answer: answer.label` (`Chat.tsx:592`); `submitSurvey` bundles labels into one
   message (`Chat.tsx:544-557`). The clean `value`s in `surveyQuestions.ts` never leave
   the client, so the agent must re-map UA text. `save_workspace_context.transport_mode`
   is an unconstrained string (`tools.ts:159/677`) → storing "Море" instead of "sea"
   makes the sidebar `<select>` render blank.
3. **Coverage gaps.** The survey never asks Incoterm *codes* (only single/split/unknown),
   `origin_country`/`destination_country`, or party *company names* — so those sidebar
   fields can't populate from survey answers regardless.
4. **PATCH /survey writes only `survey_answers`/`survey_status`** (by design,
   `workspaces.ts:361-394`); intake columns are delegated to the (non-deterministic)
   agent tools.

### Fixes (recommended: 2 + 1, with 3 as insurance)
- **Fix 1 (smallest, fixes the visible symptom):** pass `onTurnComplete` to the supply
  `<Chat>` that re-GETs `/api/workspaces/:id` + `/parties` and pushes down; give
  `ShipmentPanel` a `refreshKey` prop (or lift its fetch to the page) and re-sync the
  intake form when intake fields change (guard against clobbering unsaved edits).
- **Fix 2 (deterministic, recommended):** thread the option `value` through
  `answerQuestion`, and on `submitSurvey` write the fields the survey *can* supply
  directly — `PATCH /intake { contract_type, transport_mode, product_category }` using
  the slug `value` (matches `shipmentOptions.ts`), instead of relying on the agent. Keep
  the agent turn for the advisory summary only.
- **Fix 3 (insurance):** constrain `save_workspace_context.transport_mode` to an enum;
  include the machine `value` alongside the label in the submitted message.

---

## Problem 2 — Over-asking; users want autopilot

### Root cause
- **Rule 1 is a maximal hard-stop** (`systemPrompt.ts:144-150`): before supplier
  instruction / `get_discrepancies` / HS-code / report, the agent must call
  `get_missing_context` and, if ANY of 6 fields is unset, **stop and ask** — no defaults.
  The new `contractModeBlock` adds a *second* nag (survey suggestion on any missing
  param, `:108-111`).
- **`get_missing_context` requires 6 things** (`parties.ts:141-159`):
  contract_type, product_category, incoterm_in, transport_mode, origin_country + a
  sender party. One gate for 4 different actions; over-broad (`get_discrepancies` is
  deterministic and needs none; report renders "—" for nulls).
- **Auto-detection exists but is never persisted.** `analyzeParties`/`decideParties`
  (`partyExtraction.ts`) derive parties + contract_type + origin with confidence;
  `suggestIncoterms` (`incoterms.ts`) derives incoterm_in/out. But they're only called
  read-only (`/parties/suggest`, `get_contract_mode`) or applied to **local React state**
  (`ShipmentPanel.tsx:325-332`). The **worker never persists** them
  (`worker/index.ts:141-231` does folders/risks/reconcile only). So the DB stays empty →
  the gate keeps asking.

### What docs can auto-supply today vs genuinely needs the user
- **Auto-inferable now:** contract_type, origin_country (`country_of_origin`),
  incoterm_in/out, sender/intermediary/recipient parties, HS-code candidates.
- **Not extracted today (may need user or new inference):** `product_category`,
  `transport_mode` (both inferable later from goods description / transport doc_type).

### Fixes (ranked by impact)
- **A (keystone): auto-persist in the worker.** After extraction
  (`worker/index.ts` ~`:186`), best-effort call `analyzeParties` + `suggestIncoterms`,
  persist results with `source='auto'`, **only filling NULL fields** and **respecting
  the manual lock** (reuse `runSetContractMode`'s lock check `tools.ts:844-849` and
  `runSaveContext`/`upsertParties` write paths), then `refreshAfterWorkspaceWrite`.
  Shrinks missing-context from 6 → ~2 with zero prompts and makes the sidebar populate
  automatically (also fixes #1).
- **B: relax Rule 1** to best-effort + flagged assumptions; keep the hard-stop ONLY for
  `generate_supplier_instruction`. Remove `get_discrepancies` and `generate_report`
  from the gate.
- **C: per-action context needs** instead of one 6-field gate.
- **D: confidence-gated asking** — persist when confidence high; only propose the survey
  when confidence is low or a field is genuinely un-inferable.
- **E: shrink the survey** to what docs can't infer (product_form, transport, priority) —
  a 10-question survey becomes a 2-3 question confirmation.
- **F (optional): extend extraction** to infer transport_mode (from BoL/CMR/AWB doc_type)
  and product_category (from goods description / HS chapter) → full autopilot.

---

## Problem 3 — Files misread + agent less effective than raw chat

### A. Reading / ingestion
- **A1 (highest-leverage): PDF text glued without spaces.** `extractPdf` concatenates
  same-Y items with no separator (`extract/index.ts:52`), collapsing multi-column
  customs tables and detaching numbers from labels. Degrades both semantic chunks and
  the text-path extraction. **Fix:** insert space/column delimiter by X-gap.
- **A2: OCR only fires on ZERO text** (`worker/index.ts:87`). A mostly-scanned PDF with
  a thin text layer skips OCR and indexes near-empty as "ready". **Fix:** trigger OCR by
  text *density* (chars/page), not `pages.length === 0`; per-page OCR for empty pages.
- **A3: near-empty vision extraction still marked `ok`** (`worker/index.ts:161` vs the
  `unreadable` placeholder only on `pages.length===0`, `:162`). Silent no-content files
  never reach manual verification. **Fix:** treat all-null/empty extractions as
  `no_fields`/`unreadable`.
- **A4: structured extraction capped at `max_tokens: 4096`** (`extractFields.ts:434`) —
  large packing lists truncate the tool JSON → lost/undercounted line_items. **Fix:**
  raise to 8k-16k; detect `stop_reason==='max_tokens'` and paginate.
- **A5: legacy `.doc` effectively never read** (docx path catches→[], not pdf/image so
  no vision) → generic `unreadable`. **Fix:** surface "convert to .docx/PDF" explicitly.
- **A6: embedding failure blinds `search_documents` silently** (`qdrant.ts` returns [] on
  error; tool says "nothing found", `tools.ts:1106`). Reading itself is fine (confirmed).
  **Fix:** detect "files exist but 0 vectors" and steer to read_file fallback.

### B. Effectiveness vs raw chat
- **B1 (dominant): `max_tokens: 4096` on every agent turn** (`loop.ts:76`) with
  `thinking: adaptive` (`:75`) — thinking tokens eat the answer budget, so long outputs
  (consolidated tables, reports, multi-doc write-ups) truncate mid-sentence. **Fix:**
  raise to 8k-16k (per-kind for consolidated/report); ensure thinking doesn't starve the
  answer; auto-continue on `stop_reason==='max_tokens'`.
- **B2: 8-iteration cap can end the turn with no final answer** (`loop.ts:42`) — if the
  8th round is `tool_use`, tools run and the loop exits with no synthesis call. **Fix:**
  raise cap (12-16) and, on cap, do a final `tool_choice:'none'` call to force a closing
  answer.
- **B3: over-grounding.** Rule 1 hard-stop blocks read-only analysis (a "any
  discrepancies?" gets interrogated for intake); Rule 2 forbids reasoning over
  just-read content; Rule 4 turns empty search into a dead-end. **Fix:** scope the
  hard-stop to generation actions only; allow "read + reason, clearly labeled" when
  deterministic tools are empty.
- **B4: no retrieval fallback chain** — empty semantic search → "I found nothing"; the
  prompt never says to try `list_files`/`read_file`. **Fix:** add the fallback in the
  prompt and/or auto-fallback in `runSearch`.
- **B5: normal chat punts** shipment questions to another screen (`systemPrompt.ts:219-245`)
  instead of answering from general knowledge — reads as unhelpful vs raw ChatGPT.
- **B6: HS-code + portrait force upfront interrogation** before any answer
  (`:172-178`, `:10-21`). **Fix:** allow "best candidate first, then alternatives +
  caveat" and answer directly when the good is already described.
- **B7: config** — model `claude-opus-4-8` (fine); no temperature set (SDK default 1.0);
  a lower temp (0-0.2) would steady deterministic extraction.

---

## Prioritized action plan (across all 3 problems)

**P0 — quick, high-impact (mostly config/prompt):**
1. Raise agent `max_tokens` 4096 → ~12k + auto-continue on truncation (`loop.ts`). [#3-B1]
2. Raise `MAX_ITERATIONS` + final no-tools synthesis call on cap (`loop.ts`). [#3-B2]
3. Fix PDF text spacing/column delimiter (`extract/index.ts`). [#3-A1]
4. OCR by text-density, not zero-text (`worker/index.ts`). [#3-A2]
5. Raise structured-extraction `max_tokens` (`extractFields.ts`). [#3-A4]
6. Sidebar refresh on `onTurnComplete` for the supply chat (`page.tsx` + `ShipmentPanel`). [#1-Fix1]

**P1 — the autopilot keystone + prompt loosening:**
7. Worker auto-persist of parties/intake with `source='auto'`, NULL-only, lock-respecting
   (`worker/index.ts`, reusing existing derivers + lock). [#2-A] → also fixes #1 & shrinks survey.
8. Relax Rule 1 to best-effort + flagged assumptions; hard-stop only for supplier
   instruction; drop discrepancies/report from the gate (`systemPrompt.ts`). [#2-B, #3-B3]
9. Search→list_files→read_file fallback (prompt + `runSearch`). [#3-B4/A6]
10. Deterministic client-side survey→intake mapping using `value` (`Chat.tsx`). [#1-Fix2]
11. Shrink/conditionalize the survey to un-inferable fields (`surveyQuestions.ts`). [#2-E]

**P1 — reading integrity:**
12. Flag near-empty vision extraction as `no_fields`/`unreadable` (`worker/index.ts`). [#3-A3]
13. Explicit `.doc` "convert" guidance (`extract`/worker). [#3-A5]

**P2:**
14. Normal chat answers general questions; direct-but-caveated HS answers (`systemPrompt.ts`). [#3-B5/B6]
15. Lower extraction temperature (`extractFields.ts`). [#3-B7]
16. Extend extraction to infer transport_mode/product_category → full autopilot (#2-F).

## Open questions for the owner (max 5)
1. **Autopilot vs safety:** OK to relax Rule 1 so read-only analysis (discrepancies/risks)
   runs on best-effort with flagged assumptions instead of hard-stopping? (Compliance
   posture for HS codes stays cautious.)
2. **Survey scope:** shrink to ~3 confirm-questions (product form, transport, priority)
   once docs auto-fill the rest? Or keep the full 10 as an optional "detailed" mode?
3. **Deterministic vs agent persistence for the survey:** write intake fields client-side
   on submit (deterministic, instant sidebar) vs keep it agent-driven?
4. **max_tokens budget:** target ~12k acceptable (latency/cost) for chat turns, higher for
   consolidated/report?
5. **`.doc` policy:** auto-reject with a "convert" message, or attempt LibreOffice-style
   server conversion later?
