# Action Prompt — Phase 3: Parties (manual free-text + LLM auto-extraction)

> Standalone action prompt derived from the Shipment/Journal sidebar audit
> (`read-only-audit-wild-milner.md`). **Depends on Phase 1** (relaxed `parties.role` CHECK +
> widened `PartyRole` type) and reuses the Phase 2 `<Combobox>`. Backend + frontend.

## Role & constraints

Working in the **AI Import Assistant** repo (`C:\Projects\Артем\AI Import Assistant`), backend
(Fastify 5 / TS / ESM-NodeNext) + frontend (`frontend/`).

Hard rules:
- **Anthropic key stays server-side only** (`src/anthropic/client.ts`). The browser never calls
  Anthropic/Voyage. All extraction runs on the server.
- **This does NOT introduce a second product agent.** It extends the existing deterministic,
  forced-tool extraction utility (`src/services/extraction/extractFields.ts`) that already runs in the
  worker — it is not part of the chat agent's tool-use loop, so the single-agent constraint is intact.
- Auto-filled values **must remain user-editable**; the extraction step **suggests**, it never
  silently overwrites the saved parties set.
- ESM local imports end in `.js`; validate bodies with `zod`; strict TS.
- **Stop at `npm run typecheck` + `npm run build` (backend) and `cd frontend && npm run build` green.**

## Approach (reuse over rebuild)

The per-document extractor already pulls `buyer`, `seller`, `country_of_origin` on every index and
stores them in `document_extractions` (`worker/index.ts:111-125`). Phase 3:
1. **Enriches** that extraction with structured party objects (name/role/country/address).
2. Adds a server-side **aggregation** step that dedups parties across the workspace's stored
   extractions and returns them as **suggestions** with provenance + a simple confidence signal.
3. Frontend gets an **"Автозаповнення сторін"** action that fetches suggestions, merges them into the
   editable parties list with an **auto/manual badge**, and saves via the existing `POST …/parties`.

**No schema migration is needed** — provenance rides in the existing `parties.contact_info` JSONB.

---

## Part 1 — Enrich the extraction schema (`src/services/extraction/extractFields.ts`)

Add a structured `parties` array alongside the existing scalar fields (keep `buyer`/`seller` — they
stay useful for discrepancy checks).

- `ExtractedFields` (`:34-47`): add
  `parties: { name: string; role: string | null; country: string | null; address: string | null }[];`
  (default `[]`).
- `EXTRACTION_TOOL.input_schema.properties` (`:56-73`): add a `parties` array property, each item
  `{ name, role, country, address }`, with a Ukrainian description instructing the model to list every
  distinct company/party named in the document with its apparent role (продавець/покупець/посередник/
  вантажоодержувач тощо) and country/address if present. Do **not** add it to `required`.
- `normalize()` (`:90-109`): coerce/clean the `parties` array (trim strings via `toStr`, drop entries
  with no `name`, default missing fields to `null`). Guard against non-array input.

The worker (`worker/index.ts:117-124`) JSON-stringifies the whole `ExtractedFields`, so the new
`parties` array is persisted automatically — **no worker change required.** Re-indexing existing files
will backfill it (best-effort).

## Part 2 — Aggregation service + route (suggestions, read-only)

**New service** `src/services/partyExtraction.ts`:
- `export async function suggestParties(workspaceId: string): Promise<PartySuggestion[]>`
  - Read all `document_extractions` for the workspace (join `files` for the document name).
  - Collect party candidates from each row's `extracted_fields`: the new `parties[]` plus the legacy
    `seller`→`supplier` / `buyer`→`our_company` mappings (see role-mapping decision below).
  - **Dedup** by normalized company name (lowercase, collapse whitespace/punctuation). Merge duplicates,
    accumulating the set of source document names.
  - Return `PartySuggestion[]` where each = `{ role, company_name, country, source_files: string[],
    confidence: number }`. Use a simple corroboration confidence: `min(1, source_files.length / N)` or
    a `high|medium|low` band by how many documents mention the party — pick one and document it.
  - This service makes **no new LLM call** — it aggregates already-stored extractions. (Optional
    fallback: if the workspace has zero extractions yet, you MAY call `extractDocumentFields` on the
    concatenated text of contract/invoice files; keep this optional and clearly separated.)

**New route** in `src/routes/parties.ts`:
- `POST /api/workspaces/:id/parties/suggest` (auth, `getOwnedWorkspace` scope) →
  `{ suggestions: PartySuggestion[] }`. **Does not write** to the `parties` table.

**Role-mapping decision (heuristic — flag it):** map extracted `seller`→`supplier`,
`buyer`→`our_company`, any additional distinct party→`intermediary`, and pass through an explicit
`role` from the enriched `parties[]` when the model provided one. This is a best-effort default the
user then edits. Note it in the code; do not treat it as authoritative.

## Part 3 — Free-text roles + provenance persistence

- **`src/routes/parties.ts`** `partySchema` (`:7-13`): change `role` from
  `z.enum(['our_company','supplier','intermediary'])` to `z.string().min(1)` (if Phase 1 didn't
  already). Leave `contact_info: z.record(z.unknown()).optional()` as the carrier for provenance.
- **Provenance convention (no migration):** store `contact_info.source = 'auto' | 'manual'` and,
  for auto entries, `contact_info.source_files: string[]`. `upsertParties`
  (`src/services/parties.ts:32-65`) already persists `contact_info` verbatim — no change needed there.
- **`validateParties` / `getMissingContext`** (`parties.ts:68-118`): leave the canonical-string logic
  as-is for now (still valid; simply won't warn on non-canonical roles). **Decision to confirm:**
  once roles are free-text, `getMissingContext`'s `role = 'supplier'` "parties present" check
  (`:111-115`) may under-report — consider broadening to "≥1 non-internal counterparty exists". Flag
  for the owner rather than changing grounding behavior silently.
- Update **`API_CONTRACT.md`**: document the new `POST …/parties/suggest` endpoint and note that
  `contact_info` may carry `source`/`source_files`.

## Part 4 — Frontend parties UI (`frontend/components/ShipmentPanel.tsx`, `:270-292`)

- **Free-text / preset roles:** replace the fixed 3-option `<select>` (`:274-278`) with either the
  Phase 2 `<Combobox>` (free text allowed) or an `<input className="input">` + `<datalist>` of presets:
  `наша компанія, постачальник, посередник, продавець, покупець, вантажоодержувач, агент`. Persisted
  role is the free-text string. Widen the local `updateParty` typing accordingly (`PartyRole` is now
  `string` after Phase 1).
- **Country field** per party: reuse the Phase 2 `<Combobox>` for consistency (currently a plain input
  at `:280`).
- **"Автозаповнення сторін" button** (new, in the Сторони section): calls
  `POST /api/workspaces/${workspaceId}/parties/suggest`, then merges returned suggestions into the
  local `parties` state — append suggestions not already present (match on normalized company name),
  each tagged `contact_info.source = 'auto'`. Show a busy state via the existing `run()` helper
  (`:84-97`) and surface any warning via the existing `result` panel.
- **Auto/manual badge:** for each party row, if `contact_info?.source === 'auto'` render a small muted
  pill (e.g. "авто", styled with existing tokens like `--warn`/`--muted`) next to the role. **When the
  user edits any field of an auto row**, flip `contact_info.source` to `'manual'` (and drop the badge)
  so provenance stays truthful.
- Saving continues through the existing **"Зберегти"** → `POST …/parties` path (`saveParties`,
  `:133-145`); include `contact_info` in the payload so provenance persists. Keep showing the
  server's soft `warnings`.
- **`frontend/lib/types.ts`:** ensure `Party.role` is `string` (Phase 1) and that `contact_info` can
  hold `{ source?: 'auto'|'manual'; source_files?: string[] }` (loosen the type if needed); add a
  `PartySuggestion` type mirroring the endpoint.

## Out of scope for Phase 3
- 2/3-party auto-detection driving `contract_type` and the intermediary-only UI field, and the
  party-count checklist dimension — that is **Phase 4** (it consumes the party data this phase produces).
- Duplicate/Delete/status buttons (Phase 5), export (Phase 6), folder merge (Phase 7), icon CSS (8).
- Any new DB columns — provenance rides in `contact_info` JSONB.

## Verification
1. Backend: `npm run typecheck` + `npm run build` clean.
2. Frontend: `cd frontend && npm run build` clean.
3. End-to-end (staging, not prod): upload a contract + invoice to a shipment, wait for indexing, then
   click **Автозаповнення сторін** → suggested parties appear with an "авто" badge and provenance
   (source document). Edit an auto party's company name → badge flips to manual. Save → `GET …/parties`
   round-trips the parties **and** their `contact_info.source`. A party saved with a custom role
   (e.g. `консигнатор`) persists without a DB CHECK error (confirms Phase 1 relax).
4. Confirm the browser never calls Anthropic directly (extraction/suggest are server-side only).
5. Re-index a file and confirm the enriched `parties[]` lands in `document_extractions.extracted_fields`.

## Suggested commit (only if asked)
`feat(parties): free-text roles + LLM party auto-extraction (suggest endpoint + provenance badge)`
