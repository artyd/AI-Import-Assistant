# Action Prompt — Phase 5: Action buttons (Duplicate + Delete) + status

> Standalone action prompt derived from the Shipment/Journal sidebar audit
> (`read-only-audit-wild-milner.md`). Backend (one new endpoint) + frontend.

## Role & constraints

Working in the **AI Import Assistant** repo (`C:\Projects\Артем\AI Import Assistant`).

- Delete is destructive and outward-facing → **always confirm** before firing.
- Duplicate is **additive** — it clones shipment context, never files.
- Every workspace-scoped route calls `getOwnedWorkspace(userId, id)` and 404s on miss.
- ESM local imports end in `.js`; zod-validate bodies; strict TS.
- **Stop at `npm run typecheck` + `npm run build` (backend) and `cd frontend && npm run build` green.**

## Context (what already exists — do NOT rebuild)

- **Status is already fully wired.** The sidebar has a 6-value status `<select>`
  (`ShipmentPanel.tsx:211-227`) → `setStatus` (`:114-121`) → `PATCH /api/workspaces/:id/status`. The
  confirmed decision is to **keep the existing 6 values as-is**. → **No status work is needed** beyond
  confirming it renders. Do not add a new enum or migration.
- **Delete already exists on the backend** (`DELETE /api/workspaces/:id`, `workspaces.ts:102-113` —
  purges Qdrant vectors + disk storage, then DB cascade) and on the **workspaces list page**
  (`app/workspaces/page.tsx:35-53`, `del` with `window.confirm` + optimistic removal). It is **not** in
  the sidebar yet.
- **Duplicate does not exist anywhere** — fully new.
- The create flow (`POST /api/workspaces`, `workspaces.ts:28-59`) is the template for cloning: it
  INSERTs the workspace then loops `FOLDER_SKELETON` to seed folders, all in one transaction.

## Goal

Add **Duplicate** and **Delete** actions to the right sidebar; leave status as-is.

---

## Part 1 — Backend: duplicate endpoint (`src/routes/workspaces.ts`)

Add `POST /api/workspaces/:id/duplicate` (auth, `getOwnedWorkspace` scope). Clone in one transaction,
mirroring the create handler's structure (`:36-58`):

- Load the source via `getOwnedWorkspace`; 404 on miss.
- INSERT a new workspace owned by the same user, copying the **shipment-context scalars**:
  `supplier, contract_type, product_category, incoterm, transport_mode, origin_country,
  destination_country` (destination_country from Phase 1). Set:
  - `number` → derive a lineage-signalling value, e.g. `"${src.number ?? ''}-копія"` (or reuse
    `defaultNumber()` if the source has none).
  - `status` → `'draft'` (a fresh copy is not "done").
  - `intake_complete` → do **not** copy true blindly; either copy the source value or recompute — since
    the same intake scalars are copied, copying the source's `intake_complete` is consistent. (If you
    copy `intake_complete = true`, call `refreshWorkspaceState` on the new row so its checklist/status
    are computed, matching the create/patch convention.)
- Seed the folder skeleton for the new workspace with the **same `FOLDER_SKELETON` loop** (`:45-49`).
  Do NOT copy files, conversations/messages, extractions, checklist items, artifacts, or Qdrant vectors.
- Return `reply.code(201).send({ workspace })` with the same projection shape as create.

**Decision to confirm (parties):** the plan says "clone workspace + folder skeleton, no files."
**Recommendation:** also copy the `parties` rows (they are cheap contract context, not documents) via a
single `INSERT … SELECT` inside the same transaction, preserving `role/company_name/is_internal/country/
contact_info`. If the owner wants a truly blank copy, skip parties. Flag whichever you choose in a code
comment; default to **copying parties**.

Update **`API_CONTRACT.md`** with the new endpoint (request: none/`{}`; response `201`:
`{ workspace: {…} }`).

## Part 2 — Frontend: sidebar buttons (`frontend/components/ShipmentPanel.tsx`)

- **Add `useRouter`:** `import { useRouter } from "next/navigation";` and `const router = useRouter();`
  inside the component (it is not imported today). Reuse the existing `run()` busy helper (`:84-97`).
- **Duplicate handler:**
  ```ts
  const duplicate = () => run("duplicate", async () => {
    const res = await api<{ workspace: Workspace }>(
      `/api/workspaces/${workspaceId}/duplicate`, { method: "POST", body: {} });
    router.push(`/workspaces/${res.workspace.id}`);
  });
  ```
- **Delete handler** (mirror the list page's confirm text at `page.tsx:37-41`):
  ```ts
  const del = () => run("delete", async () => {
    const ok = window.confirm(
      `Видалити поставку №${workspace.number ?? "—"}?\n\n` +
      "Буде видалено всі файли, папки та чати цієї поставки. Дію не можна скасувати.");
    if (!ok) return;
    await api(`/api/workspaces/${workspaceId}`, { method: "DELETE" });
    router.push("/workspaces");
  });
  ```
  > Note on `window.confirm`: it is a native browser dialog and is used already on the list page, so it
  > is consistent here. (It is fine in the real app; only automated browser-tooling sessions must avoid
  > triggering such dialogs.)
- **UI placement:** add a **"Керування"** section (or extend the existing Дії section `:295-305`) with a
  **Дублювати** button (secondary `.btn`, disabled while `busy === "duplicate"`, with `IconSpinner`
  when busy) and a visually-separated **Видалити** button styled as a danger action (e.g. muted/danger
  color via existing tokens like `--err`; keep it distinct from the primary export button so it isn't
  clicked by accident). Use `IconTrash` (already exported, used in `app/workspaces/page.tsx:14`) for
  Delete; for Duplicate reuse an existing icon or add a small copy/duplicate icon to
  `frontend/components/icons.tsx` if none fits (verify what exists before adding).

## Out of scope for Phase 5
- Status enum changes (confirmed: keep the existing 6 values, already wired).
- Export changes (Phase 6), folder merge (Phase 7), icon-centering CSS (Phase 8).
- Copying files/conversations/extractions into a duplicate (explicitly not cloned).

## Verification
1. Backend: `npm run typecheck` + `npm run build` clean.
2. Frontend: `cd frontend && npm run build` clean.
3. End-to-end (staging): on a shipment, click **Дублювати** → lands on a new shipment whose number is
   `…-копія`, status `draft`, intake scalars (incoterm/transport/countries/contract_type) copied, an
   empty folder skeleton, and **no files**. Click **Видалити** → after confirm, the DELETE fires and
   the app navigates to `/workspaces` and the shipment is gone from the list.
4. Confirm duplicate is scoped: a second user cannot duplicate another user's workspace (404).
5. Confirm the status dropdown still overrides status as before (unchanged).

## Suggested commit (only if asked)
`feat(workspaces): duplicate endpoint + Duplicate/Delete actions in the shipment sidebar`
