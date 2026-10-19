# Action Prompt — Phase 6: Export (colored HTML shipment report)

> Standalone action prompt derived from the Shipment/Journal sidebar audit
> (`read-only-audit-wild-milner.md`). **Depends on Phase 1** (`destination_country`) and benefits from
> Phase 3 (flexible roles / provenance). Mostly backend `render()` edits + a small frontend reprioritise.

## Role & constraints

Working in the **AI Import Assistant** repo (`C:\Projects\Артем\AI Import Assistant`).

- The report is **self-contained** — all CSS inlined, no external asset dependencies (fonts degrade to
  system stacks). Keep it that way; do not add remote assets.
- Conclusions/figures are **derived deterministically** from checklist + discrepancy + extraction data
  — never free-standing LLM text. Preserve that.
- ESM local imports end in `.js`; strict TS.
- **Stop at `npm run typecheck` + `npm run build` (backend) and `cd frontend && npm run build` green.**

## Context (what already exists — do NOT rebuild)

The colored HTML report exists end-to-end and is **not greenfield**:
- `src/services/report.ts` — `render()` (`:77-190`) emits the full document with an inlined colored
  palette (`:119-125`) and sections: Огляд (Incoterms/Транспорт/Країна походження, `:158-163`), Сторони
  table (`:165-167`, `partiesRows` at `:89-94`), Комплектність %, color-coded Розбіжності, Ключові
  показники, Висновки. `buildAndSaveReport(ws)` (`:192-206`) gathers data and saves a
  `shipment_report_html` artifact.
- `POST /api/workspaces/:id/report` (`src/routes/report.ts`) returns `{ artifactId, html }`.
- Frontend already has an **"HTML-звіт"** button (`ShipmentPanel.tsx:300`, `genReport` `:185-194`) that
  opens the HTML in a new tab, and a separate primary **"Експорт архіву (.zip)"** button (`:302-304`).
- `WorkspaceRow` now carries `destination_country` (Phase 1), so `render(ws)` can read it.

## Goal

1. Add the **new fields** to `render()`: destination country, per-document Incoterms (read-only), and
   ensure flexible party roles + provenance display correctly.
2. **Promote** the colored HTML report to the sidebar's **primary export action**.
3. Confirm the provisional palette (decision).

---

## Part 1 — `render()` additions (`src/services/report.ts`)

- **Огляд table (`:158-163`):** add **Країна призначення** (`esc(ws.destination_country ?? '—')`). The
  table uses `th/td/th/td` rows; add a row pairing it with Тип контракту, e.g.:
  ```html
  <tr><th>Країна призначення</th><td>${esc(ws.destination_country ?? '—')}</td>
      <th>Тип контракту</th><td>${esc(ws.contract_type ?? '—')}</td></tr>
  ```
- **Per-document Incoterms (read-only) — new section.** This is where the deferred "per-doc incoterm
  read-only" surfaces. Add a gather helper mirroring `gatherFigures` (`:33-50`):
  ```ts
  async function gatherDocIncoterms(workspaceId: string):
    Promise<{ name: string; doc_type: string | null; incoterm: string | null }[]>
  ```
  querying `document_extractions` joined to `files` (`is_latest = true`) for
  `extracted_fields->>'incoterm'` + the file name + doc_type. Render a small table
  **"Incoterms за документами"** listing each document and its extracted incoterm (only when the list is
  non-empty; otherwise omit or show a muted "—"). Thread the result through `buildAndSaveReport`'s
  `Promise.all` (`:195-200`) and `render()`'s signature (`:77-85`).
- **Flexible party roles:** `partiesRows` (`:89-94`) already renders `esc(p.role)` verbatim, so
  free-text roles from Phase 3 already display correctly — no change required there.
- **Optional provenance tag:** if a party's `contact_info.source === 'auto'`, append a small
  `<span class="tag">авто</span>` next to the company name (reuse the existing `.tag` style at `:137`),
  mirroring the existing `internal` tag. Keep it optional/minimal.

## Part 2 — Promote HTML report to primary export (`frontend/components/ShipmentPanel.tsx`)

In the Дії section (`:295-305`):
- Make the **HTML report the primary export action** — give the report button `btn btn-primary` styling
  and a clearer label (e.g. **"Експорт звіту (HTML)"**), and demote the ZIP archive to a secondary
  `.btn` (keep it available). Keep `genReport` (`:185-194`) opening the report in a new tab as today; if
  a download is preferred over open-in-tab, reuse `downloadBlob` from `lib/api.ts` (as `exportZip`
  does), but open-in-tab is acceptable for this phase.
- Do not remove the ZIP export — just reprioritise the visual hierarchy so the colored report is the
  obvious primary action.

## Part 3 — Palette confirmation (decision)

The brand tokens in `report.ts:119-125` (`--dock-white`, `--cargo-navy`, `--hazard-amber`,
`--route-teal`, `--manifest-grey`, `--customs-red`) are flagged **provisional** in the code comment at
`:16` ("not defined anywhere in the repo — flag for design review"). **Confirm the final palette with
the design owner before finalising.** If confirmed as-is, remove/downgrade the provisional comment; if
changed, update the six CSS custom properties in one place (they cascade through the whole report).

## Out of scope for Phase 6
- Per-document Incoterm **editing** (`files.incoterm_override`) — this phase is read-only display only.
- PDF/CSV/XLSX export formats (not requested).
- Folder merge (Phase 7), icon CSS (Phase 8).
- Changing the ZIP export contents/structure (`src/services/export.ts`) — leave as-is.

## Verification
1. Backend: `npm run typecheck` + `npm run build` clean.
2. Frontend: `cd frontend && npm run build` clean.
3. End-to-end (staging): on a shipment with intake filled and a couple of indexed documents, click the
   primary **Експорт звіту (HTML)** → the report opens and now shows **Країна призначення**, an
   **Incoterms за документами** section listing each doc's extracted incoterm, and the Сторони table
   with the free-text roles (and an "авто" tag if provenance is set). The ZIP export still works as a
   secondary action.
4. Confirm the report remains fully self-contained (open the saved HTML outside the app — no broken
   asset requests).

## Suggested commit (only if asked)
`feat(report): destination country + per-doc incoterms in HTML report; make it the primary export`
