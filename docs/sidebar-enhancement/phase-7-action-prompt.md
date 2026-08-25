# Action Prompt — Phase 7: Folder merge + `classify.ts` (03_Certificates, renumber 8→7)

> Standalone action prompt derived from the Shipment/Journal sidebar audit
> (`read-only-audit-wild-milner.md`). Confirmed decision: merge the two certificate folders into
> **`03_Certificates`** and renumber the rest so numbering stays contiguous (8 → 7 folders).

## Role & constraints

Working in the **AI Import Assistant** backend (`C:\Projects\Артем\AI Import Assistant`).

- The classifier update ships **in the same change** as the skeleton change — do not defer it.
- The per-workspace data migration is a **separate, explicit, dry-run-first script** (NOT auto-run on
  boot), mirroring the existing `migrateFolderSkeleton.ts` pattern. Additive/reversible in spirit;
  idempotent on re-run.
- ESM local imports end in `.js`; strict TS.
- **Stop at `npm run typecheck` + `npm run build` green.** Do NOT run the migration against production —
  hand it off as a dry-run-first command.

## Target taxonomy (after merge)

| pos | folder code |
|----|-------------|
| 0 | `01_Contract_Invoice_PackingList` |
| 1 | `02_PO` |
| 2 | `03_Certificates` ← merge of `03_Certificate_of_Origin` + `04_Quality_Certificates` |
| 3 | `04_Customs` (was `05_Customs`) |
| 4 | `05_Transport` (was `06_Transport`) |
| 5 | `06_Photos` (was `07_Photos`) |
| 6 | `07_Final` (was `08_Final`) |

Both certificate **doc_types** (`certificate_of_origin`, `quality_certificate`) are **kept** — only
their folder *target* changes. The doc_type enum, `FILENAME_RULES`, `checklist_templates` seed,
discrepancies, worker, files route, and frontend need **no change** (they key on doc_types or on dynamic
`folder.name`).

## Source-code changes

1. **`src/domain/folders.ts:7-16`** — replace `FOLDER_SKELETON` with the 7-entry array above. Update the
   header comment (currently notes the 10→8 consolidation) to note the cert merge → 7.

2. **`src/services/classify.ts`:**
   - `DOC_TYPE_TO_FOLDER` (`:18-27`): point **both** `certificate_of_origin` and `quality_certificate`
     at `'03_Certificates'`; renumber `customs_declaration → '04_Customs'`,
     `transport → '05_Transport'`.
   - The photos special-case (`:139`, currently routes images to `'07_Photos'`): update to
     `'06_Photos'`.

3. **`src/services/checklist.ts:26-33`** — in `FOLDER_CATEGORIES`, collapse the two cert entries into
   `'03_Certificates': ['certificate_of_origin', 'quality_certificate']`, and renumber
   `'05_Customs' → '04_Customs'`, `'06_Transport' → '05_Transport'`. (Photos/Final aren't in
   `FOLDER_CATEGORIES`, so no change there.)
   > **Coordinate with Phase 4:** if Phase 4's checklist `contract_type` dimension has landed, it does
   > not touch `FOLDER_CATEGORIES` — no conflict, just apply both.

4. **Optional prose:** `src/services/supplierInstruction.ts:60` — the hard-coded Ukrainian string
   mentioning "сертифікат походження, сертифікати якості" can be reworded to "сертифікати"; cosmetic,
   non-functional.

## Data migration — new standalone script

Add `src/db/migrateCertMerge.ts` modeled **exactly** on `src/db/migrateFolderSkeleton.ts` (dry-run by
default, `--apply` to execute; per-workspace transaction; idempotency guard; summary log). Wire an npm
script `migrate:cert-merge` (mirroring `migrate:folders`).

Migration logic per workspace:
- **Idempotency guard:** if neither `03_Certificate_of_Origin` nor `04_Quality_Certificates` exists →
  already merged, skip (return no actions).
- **Merge:** treat `03_Certificate_of_Origin` as the surviving folder — rename it to `03_Certificates`
  (keep position 2). If it doesn't exist but `04_Quality_Certificates` does, rename that one to
  `03_Certificates` (position 2) instead. Then, for the other certificate folder: move its files
  (`UPDATE files SET folder_id = <merged> WHERE folder_id = <other>`) and `DELETE` the emptied folder —
  reuse the `MERGE_SOURCES` fold-and-delete loop shape (`migrateFolderSkeleton.ts:120-134`).
- **Renumber** the trailing folders via a `RENAMES` table (same shape as `:31-39`):
  `05_Customs → 04_Customs (pos 3)`, `06_Transport → 05_Transport (pos 4)`,
  `07_Photos → 06_Photos (pos 5)`, `08_Final → 07_Final (pos 6)`.
- Leave inbox files (`folder_id IS NULL`) and non-skeleton folders untouched.

Keep the dry-run/apply, per-workspace `BEGIN/COMMIT/ROLLBACK`, and the printed action plan exactly like
the reference script so the operator can review before applying.

## Blast-radius note (already verified — no action needed)
The worker (`src/worker/index.ts`), files route (`src/routes/files.ts`), and the frontend
(`FileTree.tsx`, `Chat.tsx`, `workspaces/[id]/page.tsx`) reference folders only via dynamic
`folder.name` / `fo.name` — they inherit the new codes automatically. No hard-coded certificate folder
codes exist outside the four files above.

## Out of scope for Phase 7
- Changing which doc_types exist, or the filename/LLM classification rules (both cert doc_types are
  preserved; only their folder target moves).
- Icon CSS (Phase 8).

## Verification
1. `npm run typecheck` + `npm run build` clean.
2. **New workspace:** create one and confirm it seeds the 7-folder skeleton with `03_Certificates` and
   the renumbered `04_Customs … 07_Final`.
3. **Classification:** a file classified as `certificate_of_origin` OR `quality_certificate` routes into
   `03_Certificates`; a `customs_declaration` routes into `04_Customs`; an image routes into
   `06_Photos`.
4. **Checklist:** a file sitting in `03_Certificates` yields the `received` signal for BOTH certificate
   requirements (via the merged `FOLDER_CATEGORIES` entry).
5. **Migration dry-run (staging/local, NOT prod):** `npm run migrate:cert-merge` prints the per-workspace
   plan and writes nothing; `-- --apply` performs the moves; re-running is a no-op (idempotency guard).
   Hand the operator the dry-run-first command for production; do not run it against prod yourself.

## Suggested commit (only if asked)
`feat(folders): merge certificate folders into 03_Certificates + renumber; update classify/checklist`
