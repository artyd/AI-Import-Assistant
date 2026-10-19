# Action Prompt — Phase 4: 2/3-party logic + documents checklist

> Standalone action prompt derived from the Shipment/Journal sidebar audit
> (`read-only-audit-wild-milner.md`). **Depends on Phase 3** (party data + the
> `POST …/parties/suggest` endpoint). Backend + frontend.

## Role & constraints

Working in the **AI Import Assistant** repo (`C:\Projects\Артем\AI Import Assistant`).

- Additive, idempotent schema changes only (`ADD COLUMN IF NOT EXISTS`; guarded seed inserts).
- **Party count affects the checklist, NOT the Incoterms logic.** Who organizes transport / who is
  declarant stays driven purely by the selected Incoterm (Phase 2) and is independent of party count.
- Auto-detection is a **suggestion with manual override** — never force `contract_type`.
- ESM local imports end in `.js`; zod-validate bodies; strict TS.
- **Stop at `npm run typecheck` + `npm run build` (backend) and `cd frontend && npm run build` green.**

## Context (current state)

- `contract_type` (`bilateral`/`trilateral`) already exists on `workspaces` and is editable via the
  sidebar select (`ShipmentPanel.tsx:232-240`) and `PATCH /intake`.
- The checklist (`src/services/checklist.ts`) derives required docs from `checklist_templates`, matched
  **only** on `product_category / incoterm / transport_mode` (`requiredKeys`, `:41-50`). There is
  **no party-count / contract_type dimension today.** The single baseline template is the wildcard row
  seeded at `schema.sql:183-188`. `requiredKeys` unions `required_document_types` across all matching
  rows, and NULL columns act as wildcards — so an added `contract_type`-specific row is purely additive.
- Changing `contract_type` on a workspace whose `intake_complete` is true already triggers a checklist
  recompute (`workspaces.ts:157-163`), so new requirements apply automatically once wired.

## Goal

1. **Auto-detect party count** from the extracted parties → suggest `bilateral` (2) vs `trilateral`
   (3+), with the existing select as the manual override.
2. **Conditional intermediary UI** — surface a dedicated intermediary/agent party affordance only when
   `contract_type === 'trilateral'`.
3. **Checklist gains a `contract_type` dimension** — trilateral shipments require the extra
   intermediary-structure document(s).

---

## Part 1 — Auto-detect contract_type (extend Phase 3 suggest)

- **`src/services/partyExtraction.ts`** — derive a suggestion from the deduped parties:
  count distinct **non-internal counterparties** (exclude `is_internal` / our-company entries). Map
  `≥3 distinct parties → 'trilateral'`, `2 → 'bilateral'`, otherwise `null` (not enough signal).
  Export it as `suggestContractType(suggestions): 'bilateral'|'trilateral'|null`.
- **`src/routes/parties.ts`** — change the `POST …/parties/suggest` response to
  `{ suggestions, suggested_contract_type }`. (Update `API_CONTRACT.md` accordingly.)
- This adds **no new LLM call** — it reuses the aggregation from Phase 3.

## Part 2 — Checklist `contract_type` dimension

- **`src/db/schema.sql`:**
  - Append `ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS contract_type TEXT;`
    (next to the other additive ALTERs; keep it nullable = wildcard).
  - Append a **guarded** trilateral seed row (mirroring the baseline guard style at `:183-188`), e.g.:
    ```sql
    INSERT INTO checklist_templates (product_category, incoterm, transport_mode, contract_type,
                                     required_document_types)
    SELECT NULL, NULL, NULL, 'trilateral', ARRAY['intermediary_agreement']
    WHERE NOT EXISTS (
      SELECT 1 FROM checklist_templates WHERE contract_type = 'trilateral'
    );
    ```
    (The trilateral row is **additive** — trilateral workspaces get baseline docs ∪ this row.)
- **`src/services/checklist.ts`** — `requiredKeys` (`:41-50`): add the dimension to the WHERE clause
  and bind `ws.contract_type`:
  ```sql
  ... AND (contract_type IS NULL OR contract_type = $4)
  ```
  passing `[ws.product_category, ws.incoterm, ws.transport_mode, ws.contract_type]`.

### Decision to confirm (do NOT guess the domain)
The **exact extra required document(s) for a trilateral (3-party) structure** must be confirmed with
the domain owner before seeding — `intermediary_agreement` above is a **placeholder**. Also decide how
far to wire the new doc_type:
- **Minimal (default):** seed the requirement only. It shows as `missing` on the checklist until
  satisfied (the checklist tolerates unknown requirement keys — `resolveItems` just marks them missing).
- **Full:** additionally add the new doc_type to the extractor enum
  (`extractFields.ts` `DocType`/`DOC_TYPES`), a `FILENAME_RULES` entry (`classify.ts`), a
  `DOC_TYPE_TO_FOLDER` target (route it into the existing contract folder), and a `FOLDER_CATEGORIES`
  entry (`checklist.ts:26-33`) so files can reach `received`/`verified`.

**Recommendation:** ship Minimal now; do the Full wiring once the owner confirms the real doc list.
Leave a `// TODO(phase4): confirm trilateral required docs + full doc_type wiring` marker.

**Folder-merge note:** if Phase 7 (folder merge/renumber) lands before or after this, the only overlap
is `FOLDER_CATEGORIES` in `checklist.ts` — keep the two changes coordinated but they do not conflict
(this phase touches template *matching*; Phase 7 touches folder *codes*).

## Part 3 — Frontend: suggested contract_type + conditional intermediary UI

`frontend/components/ShipmentPanel.tsx`:
- **Surface the suggestion:** when `POST …/parties/suggest` returns a non-null
  `suggested_contract_type` that differs from the current value, show a small muted hint near the
  contract_type select (`:231-240`), e.g. "Виявлено N сторони — запропоновано: тристоронній", with an
  **apply** affordance that sets `form.contract_type` (persisted via the existing **Зберегти
  параметри** → `PATCH /intake`). Never auto-apply.
- **Conditional intermediary affordance:** when the effective `contract_type === 'trilateral'`, render
  a dedicated **Посередник / Агент** cue in the Сторони section — either ensure at least one party row
  with an intermediary-style role is present/prompted, or show a labeled sub-block for it. When
  `bilateral`, do not show it. (Roles are free-text after Phase 3, so this is a UI affordance over the
  existing party rows, not a new data field.) Keep it lightweight.
- Optionally show a soft note when the party set contradicts the chosen `contract_type` (the backend
  `validateParties` warnings already cover this — surface them via the existing `result` panel).

## Out of scope for Phase 4
- Duplicate/Delete/status buttons (Phase 5), export (Phase 6), folder merge/renumber (Phase 7),
  icon CSS (Phase 8).
- Rewriting Incoterms→transport logic — party count must not touch it.
- Building the full new-doc_type extraction/classification chain unless the owner confirms the doc list
  (see the Part 2 decision).

## Verification
1. Backend: `npm run typecheck` + `npm run build` clean.
2. Frontend: `cd frontend && npm run build` clean.
3. Idempotency: re-running `schema.sql` is a no-op (ALTER IF NOT EXISTS + guarded trilateral insert).
4. End-to-end (staging): on a shipment with intake complete, switch `contract_type` to `trilateral` and
   confirm the checklist recomputes to include the extra requirement (shows `missing` under Minimal);
   switch back to `bilateral` and it drops. Upload docs producing 3 distinct parties → **Автозаповнення
   сторін** returns `suggested_contract_type: 'trilateral'` and the UI offers to apply it; the
   intermediary affordance appears only in the trilateral state.
5. Confirm Incoterms→transport filtering is unchanged regardless of party count.

## Suggested commit (only if asked)
`feat(shipment): 2/3-party auto-detect + trilateral checklist dimension`
