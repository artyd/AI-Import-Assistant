# Action Prompt — Phase 1: DB schema + API (additive)

> Standalone action prompt derived from the Shipment/Journal sidebar audit
> (`read-only-audit-wild-milner.md`). Scope is intentionally small: lay the data-model
> foundation the later phases build on. **Do not** build UI, LLM extraction, folder merge,
> or export changes here — those are Phases 2–8.

## Role & constraints

You are working in the **AI Import Assistant** backend (Fastify 5 + TypeScript, ESM/NodeNext,
Postgres via `pg`) at repo root `C:\Projects\Артем\AI Import Assistant`, with the in-repo
Next.js frontend under `frontend/`.

Hard rules for this task:
- **Additive / non-destructive only.** Production is the only live environment; no data loss.
- The schema has **no versioned migrations** — `src/db/schema.sql` is re-run whole on every boot
  and must stay **idempotent** (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`).
- ESM local imports end in `.js`. Validate request bodies with `zod`. Strict TS
  (`noUncheckedIndexedAccess`).
- **Stop at `npm run typecheck` + `npm run build` green** (backend) and `cd frontend && npm run build`
  green. Do **not** run migrations against production or live-test against prod data.
- Do not commit unless explicitly asked.

## Goal

Two additive data-model changes plus their API/type wiring:

1. **New shipment field `destination_country`** (Країна призначення) — mirror the existing
   `origin_country` in every place `origin_country` appears.
2. **Relax `parties.role`** from a fixed 3-value CHECK to free-text, so later phases can use
   flexible role labels (seller/buyer/consignee/agent/…).

---

## Part 1 — `destination_country`

Add a nullable `destination_country TEXT` column and thread it through, in lockstep, everywhere
`origin_country` is already referenced. The exact anchors:

1. **`src/db/schema.sql`** — append next to the intake ALTERs (after line ~94), following the
   existing pattern:
   ```sql
   ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS destination_country TEXT;
   ```

2. **`src/services/workspaceAccess.ts`** — add `destination_country: string | null;` to the
   `WorkspaceRow` interface (after `origin_country`, `:34`). The `SELECT *` loaders pick it up
   automatically; no query change needed.

3. **`src/routes/workspaces.ts`:**
   - GET projection (`:79-93`): add `destination_country: ws.destination_country,`.
   - `patchSchema` (`:117-127`): add `destination_country: z.string().nullable().optional(),`.
     (The generic whitelist loop interpolates the zod key as the column name, so the key **must**
     stay snake_case = `destination_country`.)
   - `intakeSchema` (`:187-193`): add `destination_country: z.string().nullable().optional(),`.

4. **`src/agent/tools.ts`** — `saveContextSchema` (`:281-297`): add
   `destination_country: z.string().optional(),`; add `'destination_country'` to the `scalarKeys`
   tuple (`:307-313`).

5. **`src/services/report.ts`** — `render()` Огляд table (`:158-163`): add a
   **Країна призначення** cell rendering `esc(ws.destination_country ?? '—')` (place it alongside
   Країна походження; adjust the table row layout as needed).

6. **`frontend/lib/types.ts`** — add `destination_country?: string | null;` to the `Workspace`
   interface (after `origin_country`, `:27`).

### Decision to confirm (do NOT change behavior silently)
`intake_complete` is derived from **exactly five** required fields
(`src/routes/workspaces.ts:215-221`; also `getMissingContext` in `src/services/parties.ts:103-109`).
**Default for this phase: `destination_country` is OPTIONAL — do NOT add it to the required-five
derivation.** Making it required would retroactively flip existing "complete" shipments back to
incomplete. If the product owner wants it required, that is a deliberate follow-up, not part of
this additive phase — leave a `// TODO(phase1): destination_country intentionally not gating
intake_complete — confirm with owner` note rather than wiring it in.

---

## Part 2 — Relax `parties.role` to free-text

The role CHECK is defined **inline** in the `CREATE TABLE parties` (`src/db/schema.sql:104`):
`role TEXT NOT NULL CHECK (role IN ('our_company','supplier','intermediary'))`. Postgres names
that inline constraint `parties_role_check`.

1. **`src/db/schema.sql`:**
   - In the `CREATE TABLE IF NOT EXISTS parties` block, change the role line to drop the inline
     CHECK (keep `NOT NULL`): `role TEXT NOT NULL,` — this covers fresh installs.
   - **Append at the bottom** of the file (mirroring the status-constraint pattern at `:176-179`),
     so existing production DBs are migrated idempotently:
     ```sql
     -- Parties role relaxed to free-text (flexible role labels).
     ALTER TABLE parties DROP CONSTRAINT IF EXISTS parties_role_check;
     ```

2. **Widen the TypeScript types** so free-text roles typecheck end to end:
   - `src/services/parties.ts:10` — `export type PartyRole = string;` (keep the type name so all
     references stay valid). `validateParties` / `getMissingContext` keep referencing the canonical
     strings `'supplier'`/`'our_company'`/`'intermediary'` — that still works (they simply won't
     warn on other role labels); leave their logic unchanged this phase.
   - `src/agent/tools.ts` — in `saveContextSchema` (`:290`), change the party `role` from
     `z.enum(['our_company','supplier','intermediary'])` to `z.string().min(1)`.
   - `src/routes/parties.ts` — the `partySchema` `role` field (around `:7-13`): change the role
     validator to `z.string().min(1)` (confirm the exact current shape when you open the file).
   - `frontend/lib/types.ts:39` — `export type PartyRole = string;`.

### What NOT to touch in Part 2 (deferred to Phase 3)
- Do not add the auto-filled-vs-manual badge, the LLM parties extraction, or a preset role picker
  UI. This phase only relaxes the constraint + types so those later changes are unblocked.
- Do not change `upsertParties`' replace semantics or `validateParties`' warning text.

---

## Out of scope for Phase 1 (explicitly)
- Any frontend dropdown/combobox components or `ShipmentPanel.tsx` edits (Phase 2).
- `files.incoterm_override` / per-document incoterm (deferred per audit decision).
- Status enum changes — confirmed to reuse the existing 6 values as-is.
- Folder merge, checklist party-count dimension, Duplicate/Delete buttons, export promotion, icon CSS.

## Verification
1. Backend: `npm run typecheck` then `npm run build` — both must be clean.
2. Frontend: `cd frontend && npm run build` — must be clean.
3. Idempotency sanity (do NOT run against prod): confirm every new SQL statement uses
   `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` so a re-run of `schema.sql` is a no-op.
4. Grep check: `origin_country` and `destination_country` should now appear in the same set of
   files (schema.sql, workspaceAccess.ts, workspaces.ts, tools.ts, report.ts, frontend/lib/types.ts).
   Any `origin_country` reference without a matching `destination_country` sibling is a missed spot.
5. Optional (staging only, if available): `npm run migrate` then a `PATCH /api/workspaces/:id`
   with `{ "destination_country": "Німеччина" }` and confirm it round-trips on `GET /:id`; a
   `POST /:id/parties` with a custom role (e.g. `"consignee"`) should succeed without a DB error.

## Suggested commit (only if asked)
`feat(workspaces): destination_country field + free-text party roles (schema + API + types)`
