# Read-Only Audit — Shipment/Journal Right Sidebar Enhancement

> **Status: AUDIT + PLAN ONLY.** No files were modified, no migrations run, nothing committed.
> This document is the findings report and the phased implementation plan. The next step is
> a set of focused, standalone action prompts — one per phase.

## Context

The right-sidebar "Постачання / Журнал" panel needs to become fully functional: real dropdowns
for Incoterms / Транспорт / Країна (origin **and** destination), editable + LLM-auto-filled
Сторони, action buttons + colored-HTML export, a certificate-folder merge, a 2/3-party
checklist, and an icon-centering CSS fix.

**The single most important finding: the brief's premise "no relevant DB fields/API currently
exist … design from scratch" is largely inaccurate.** Most of the backend already exists and
works. This audit re-scopes the work from "greenfield" to "extend + wire up", which is
considerably smaller. The genuinely new pieces are: **destination country**, **flexible party
roles**, **LLM parties auto-extraction**, and **frontend dropdown/combobox components** (no UI
library is installed).

### Two premises in the brief that the repo contradicts (flagged, not resolved)
1. **The frontend is committed.** The brief says it "lives locally … not yet committed to the
   repo." In fact `frontend/` is git-tracked (32 files) on branch `feat/sort-inbox-and-chat-history`.
2. **No uncommitted `docker-compose.yml` diff exists.** `git status` is clean; the previously-known
   local diff is not present in this working tree. Nothing to reconcile.

---

## A. Frontend — Sidebar & Fields (findings)

- **Host:** `frontend/app/workspaces/[id]/page.tsx:602-647` renders a tabbed `<aside>` (340px);
  `shipment` tab → `<ShipmentPanel>`, `log` tab → `<AgentLog>`.
- **All fields live in `frontend/components/ShipmentPanel.tsx`.** Current control types:
  | Field | Location | Control |
  |---|---|---|
  | Incoterms (`incoterm`) | `ShipmentPanel.tsx:242` | plain `<input>` (via `Field` helper `:361-368`) |
  | Транспорт (`transport_mode`) | `:243` | plain `<input>` |
  | Країна походження (`origin_country`) | `:244` | plain `<input>` |
  | Сторони (parties) | `:271-292` | repeating rows: role `<select>` (3 hard-coded opts), free-text company/country, `is_internal` checkbox |
  | Тип контракту (`contract_type`) | `:232-240` | native `<select>` bilateral/trilateral (already a dropdown) |
- **Data flow is real, not mocked.** Local `useState` (no form library, no context). Seeded from
  the `workspace` prop (from `GET /api/workspaces/:id`, `page.tsx:92-100`) and a separate
  `GET …/parties` fetch. Saves: **"Зберегти параметри"** → `PATCH …/intake` (`saveIntake` `:99-112`);
  parties **"Зберегти"** → `POST …/parties` (`saveParties` `:133-145`); status `<select>` →
  `PATCH …/status`; responsible user `<select>` → `PATCH …/:id`. API client = `frontend/lib/api.ts`
  (relative `/api/*`, Bearer from localStorage).
- **No reusable Select/Dropdown/Combobox exists.** Every dropdown is a raw native `<select>`.
  Bespoke popovers exist (`WorkspaceSelector.tsx`, `FileTree.tsx:251-328`) but are not reusable
  abstractions.
- **No UI library and no autocomplete.** `frontend/package.json` deps are only `next`, `react`,
  `react-dom`, `react-markdown`, `remark-gfm`. No shadcn/Radix/Headless UI/Tailwind/react-select/cmdk.
  Styling is hand-written CSS custom-properties in `frontend/app/globals.css`. **A searchable country
  combobox must be built from scratch** (lightest path — see Phase 2).
- **Sidebar action buttons today:** Save параметри, Status, Responsible, Parties save, plus a **Дії**
  section (`:295-305`): Комплектність, Розбіжності, Інструкція, **HTML-звіт** (`POST …/report`, opens
  blob), Експорт .zip. **No Duplicate and no Delete in the sidebar** (Delete lives on the workspaces
  list page `app/workspaces/page.tsx:35-53`; Duplicate does not exist anywhere).

## E. Icon-centering bug (diagnosed — do not fix yet)

Not "cards" — the document browser (`frontend/components/FileTree.tsx`) uses flat `tree-row` list
rows. Hover action icons are `<button className="btn-icon row-action">`.

**Root cause:** `frontend/app/globals.css:158-166` — `.btn-icon` sets size/color but **no `display`,
`align-items`, or `justify-content`**. Hidden by `.row-action { display: none }` (`:340`), it is
flipped to `display: inline-flex` on hover (`:344`). That makes it a flex container with browser
defaults `justify-content: flex-start` / `align-items: stretch`, so the fixed-size `<svg>` pins to
the **top-left**. The general `.btn` class (`:125-141`) does center its content, but these buttons use
`"btn-icon row-action"`, not `"btn btn-icon"`, so they never inherit it.
**Fix (Phase 8):** add `display:inline-flex; align-items:center; justify-content:center;` to `.btn-icon`.

## B. Backend — Data Model & API (findings)

`workspaces` table == "shipment". Schema is a single idempotent `src/db/schema.sql` re-run on every
boot (no versioned migrations; `src/db/migrate.ts:10-14`). New fields = append
`ALTER TABLE … ADD COLUMN IF NOT EXISTS …` following the phase-1 pattern at `schema.sql:88-97`.

**Existing `workspaces` columns vs. requested:**
| Requested | Status | Actual |
|---|---|---|
| incoterms | **exists** (singular) | `incoterm` TEXT, free-text (`schema.sql:92`) |
| transport_mode | **exists** | `transport_mode` TEXT (`:93`) |
| country_of_origin | **exists** | `origin_country` TEXT (`:94`) |
| **country_of_destination** | **MISSING** | — must be added |
| parties | **exists** (separate table) | `parties` table (`:101-111`) |
| party_count | **MISSING** | derived from `contract_type`; not stored |
| status | **exists** | TEXT + CHECK, 6 values (`:176-179`) |
| contract_type (2/3-party) | **exists** | `bilateral`/`trilateral` (`:88`) |

**`PATCH /api/workspaces/:id` mechanics (`src/routes/workspaces.ts:117-165`):** a generic whitelist
loop interpolates **zod keys directly as SQL column names**, so any new field's zod key MUST equal its
snake_case DB column. Adding a scalar shipment field means touching, in lockstep: `patchSchema`,
`intakeSchema` (`:187-193`), `createSchema` if relevant, the GET projection (`:86-92`), `WorkspaceRow`
(`src/services/workspaceAccess.ts:21-36`), and the agent tool `saveContextSchema`/`scalarKeys`
(`src/agent/tools.ts:281-313`).

**Parties (`src/services/parties.ts`, `src/routes/parties.ts`):** dedicated table, `role` is a **fixed
3-value CHECK** (`our_company|supplier|intermediary`). `upsertParties` = full-set replace in a
transaction. `validateParties` soft-warns (never fails) against `contract_type` counts; internal check
vs `['AGroup95','PrimeForce']`. `getMissingContext` treats parties as missing when 0 `supplier` rows.
**Requirement wants flexible roles → the CHECK must be relaxed** (see Phase 3).

**Per-document Incoterms:** `workspaces.incoterm` is one value. Each document already gets an incoterm
auto-extracted into `document_extractions.extracted_fields.incoterm` (1 row per file, but the worker
DELETEs+re-inserts on every re-index, so it is machine-owned). **Decision (confirmed): ship
shipment-level dropdown now and surface the extracted per-doc value read-only; defer a user-editable
`files.incoterm_override` to a later phase.**

## D. Parties Extraction — LLM (findings)

A forced-tool extraction pipeline already exists: `src/services/extraction/extractFields.ts`
(`extractDocumentFields`, non-streaming Claude, `tool_choice` forced to `record_extraction`). It
**already extracts `buyer`, `seller`, `country_of_origin`, `incoterm`** per document (`:34-47`).
Persisted by the worker (`src/worker/index.ts:111-125`) into `document_extractions`. Party info lives
in `contract`, `invoice`, `purchase_order`, `packing_list` docs. **A parties-extraction pipeline
extends this exact pattern** (add structured party objects to the tool schema, mirror the worker
persistence, upsert into the `parties` table) rather than building anything new.

## F. Export (findings)

**Not greenfield — the colored HTML report already exists end-to-end.** `src/services/report.ts`
`render()` (`:77-190`) emits a self-contained HTML doc with an inlined colored palette
(`:119-125`, brand tokens flagged provisional at `:16`) and already renders **Огляд (incl. Incoterms,
Транспорт, Країна походження), a Сторони table (`:165-167`), checklist %, color-coded discrepancies,
figures, conclusions**. `POST /api/workspaces/:id/report` (`src/routes/report.ts`) returns
`{ artifactId, html }`; saved as a `shipment_report_html` artifact and bundled in the ZIP export
(`src/services/export.ts`). **New sidebar fields slot into `render()` additively.** No PDF/CSV export.

## C. Document Classification — Folder Merge (findings + confirmed plan)

Folders are single numbered code-strings that are BOTH id and display name (no separate Ukrainian
labels; frontend renders `folder.name` verbatim). Taxonomy = `FOLDER_SKELETON`
(`src/domain/folders.ts:7-16`), 8 folders. **The two certificate folders:**
- `03_Certificate_of_Origin` (`folders.ts:10`)
- `04_Quality_Certificates` (`folders.ts:11`)

Routing (`src/services/classify.ts`) is a 4-step cascade producing a `doc_type`, then mapped to a
folder via `DOC_TYPE_TO_FOLDER` (`:18-27`). The cert doc_types `certificate_of_origin` /
`quality_certificate` are distinguished by filename rules (`:53-54`) and the LLM enum — **both
doc_types are kept; only their folder target changes.**

**Confirmed merge plan (decision: `03_Certificates`, renumber the rest 8→7):**
1. `src/domain/folders.ts:10-11` — replace the two codes with one `03_Certificates`; renumber
   `05_Customs→04`, `06_Transport→05`, `07_Photos→06`, `08_Final→07`.
2. `src/services/classify.ts:23-24` — point **both** `certificate_of_origin` and `quality_certificate`
   at `03_Certificates`; update the renumbered targets in `DOC_TYPE_TO_FOLDER` (and the `photos`
   special-case at `:139`).
3. `src/services/checklist.ts:26-33` — collapse `FOLDER_CATEGORIES` cert entries into one
   `'03_Certificates': ['certificate_of_origin','quality_certificate']`; update renumbered keys.
4. **Data migration** (mirror `src/db/migrateFolderSkeleton.ts` merge pattern): move files from the two
   old cert folders into the merged folder, delete the emptied one, and apply the renumber renames on
   existing workspaces.
5. Optional prose only: `src/services/supplierInstruction.ts:60`.
6. **No change needed** to the doc_type enum, filename rules, `checklist_templates` seed, discrepancies,
   worker, files route, or frontend (they key on doc_types or on dynamic `folder.name`).

**Checklist subsystem (`src/services/checklist.ts`):** requirements come from `checklist_templates`
matched on `product_category / incoterm / transport_mode` — **there is no party-count dimension today.**
The 2/3-party checklist feature needs a new matching dimension; it is **orthogonal** to the folder merge.

---

## Confirmed decisions (from clarification)
1. **Status:** reuse the existing 6-value set; sidebar keeps a manual-override dropdown. No schema/
   derivation change.
2. **Per-doc Incoterms:** shipment-level dropdown now + read-only display of extracted per-doc value;
   user-editable `files.incoterm_override` deferred.
3. **Folder merge:** `03_Certificates`, renumber subsequent folders to stay contiguous (8→7).

## Open decision points (flagged — resolve at implementation time, not guessed here)
- **Flexible party roles — how to relax the CHECK.** Recommendation: change `parties.role` to free-text
  (drop the CHECK) with a small preset suggestion list in the UI (seller, buyer, consignee, agent,
  our_company, supplier, intermediary), and keep `validateParties` as **soft warnings** mapped to a
  canonical subset. Confirm whether `getMissingContext`'s "0 supplier rows = missing" heuristic
  (`parties.ts:103-118`) should switch to a broader "no counterparty" check once roles are free-text.
- **`party_count`** — derive from `contract_type` (bilateral=2 / trilateral=3) rather than store a new
  column, unless the UI needs an explicit override independent of `contract_type`.
- **2/3-party checklist matching** — add a `contract_type` (or party-count) column to
  `checklist_templates` and seed trilateral-specific required docs; confirm the extra required docs list
  with the domain owner before seeding.
- **Colored-report brand tokens** (`report.ts:119-125`) are flagged provisional — confirm final palette.

---

## Phased Implementation Plan

Additive, non-destructive, production-only environment. **Each phase stops at `npm run typecheck` +
`npm run build` green**, not live-testing against production data. Each becomes one standalone action prompt.

### Phase 1 — DB schema + API (additive)
- `schema.sql`: append `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS destination_country TEXT;`.
- Wire `destination_country` through: `patchSchema`, `intakeSchema` + intake-complete derivation
  (decide if it becomes a 6th required field), GET projection (`workspaces.ts:86-92`), `WorkspaceRow`
  (`workspaceAccess.ts`), agent `saveContextSchema`/`scalarKeys` (`tools.ts`), and `report.ts render()`.
- Relax `parties.role` CHECK to free-text (see open decision).
- `frontend/lib/types.ts`: add `destination_country`, widen `PartyRole` to `string`.
- **Verify:** `npm run typecheck && npm run build`; `npm run migrate` is idempotent.

### Phase 2 — Incoterms / Transport / Country dropdowns
- Build **from scratch** (no UI lib): a lightweight `<Select>` and a searchable `<Combobox>` in a new
  `frontend/components/ui/` folder, styled with the existing `.input`/globals.css tokens; reuse the
  click-outside pattern from `WorkspaceSelector.tsx`.
- Incoterms: flat dropdown of the 11 Incoterms® 2020 terms. Transport: dropdown filtered by Incoterm
  (**FAS/FOB/CFR/CIF → sea + inland waterway only**; other 7 → all modes). Country origin + destination:
  ISO-3166 combobox, type-ahead on Ukrainian **and** English names.
- Ship a small static data module (incoterms list, transport modes, incoterm→transport filter map,
  country list uk+en). Surface the extracted per-doc incoterm read-only in the file view.
- Replace the plain inputs at `ShipmentPanel.tsx:242-244` with these components; keep the existing
  `PATCH …/intake` save path.

### Phase 3 — Parties: manual input + LLM extraction
- Manual: allow free-text/preset roles (Phase 1 CHECK relax); add an auto-filled-vs-manual badge.
- LLM: extend `EXTRACTION_TOOL`/`ExtractedFields` (`extractFields.ts`) with structured party objects;
  mirror worker persistence (`worker/index.ts:111-125`) to upsert into `parties`; keep values editable
  and mark provenance. Confidence handling per existing extraction normalization.

### Phase 4 — 2/3-party logic + documents checklist
- Auto-detect party count from the LLM extraction → set `contract_type` with manual override.
- UI shows the intermediary/agent field only when trilateral.
- Add a `contract_type`/party-count dimension to `checklist_templates` matching (`checklist.ts:41-50`)
  and seed trilateral-specific required docs. Does **not** affect Incoterms logic.

### Phase 5 — Action buttons + status
- Add **Duplicate** (new — clone workspace + folder skeleton, no files) and **Delete** (reuse existing
  `DELETE /api/workspaces/:id`, with confirmation) to the sidebar. Status = existing 6-value override
  dropdown (already wired via `PATCH …/status`).

### Phase 6 — Export (colored HTML report)
- Promote the existing `POST …/report` HTML report to the sidebar's primary export action; add the new
  fields (destination country, per-doc incoterms read-only, flexible parties) to `render()`. Confirm the
  provisional palette.

### Phase 7 — Folder merge + `classify.ts`
- Execute the confirmed merge (`03_Certificates`, renumber 8→7) across `folders.ts`, `classify.ts`,
  `checklist.ts`, plus a data migration modeled on `migrateFolderSkeleton.ts`. Update the classifier in
  the **same** change so both cert doc_types route into the merged folder.

### Phase 8 — Icon CSS fix
- Add `display:inline-flex; align-items:center; justify-content:center;` to `.btn-icon`
  (`frontend/app/globals.css:158-166`). One-line fix; verify hover icons center on folder + file rows.

## Verification (per phase)
- Backend: `npm run typecheck` + `npm run build`; `npm run migrate` (idempotent) for schema phases.
- Frontend: `cd frontend && npm run build` (and lint if configured).
- End-to-end (optional, staging): create a workspace, set intake fields via the new dropdowns, upload a
  contract to auto-extract parties, generate the HTML report, confirm the merged cert folder receives
  both certificate types.
- Do **not** live-test against production data; stop at build/typecheck green per project workflow.
