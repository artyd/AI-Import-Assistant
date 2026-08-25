# Action Prompt — Phase 2: Incoterms / Transport / Country dropdowns

> Standalone action prompt derived from the Shipment/Journal sidebar audit
> (`read-only-audit-wild-milner.md`). **Depends on Phase 1** (the `destination_country` column +
> API wiring must already be merged). Frontend-only, except the optional add-on in §5.

## Role & constraints

Working in the **AI Import Assistant** frontend (Next.js 15 App Router, TypeScript) under
`C:\Projects\Артем\AI Import Assistant\frontend`.

- **No UI library is installed** (deps: `next`, `react`, `react-dom`, `react-markdown`, `remark-gfm`;
  no shadcn/Radix/Tailwind). Do **not** add one. Build the searchable combobox from scratch and use
  native `<select className="input">` for the flat dropdowns (consistent with the existing
  `contract_type` select at `ShipmentPanel.tsx:232-240`).
- Styling: reuse the existing `.input` class (`app/globals.css:173-189`) and CSS custom-property
  tokens (`--surface`, `--border`, `--hover`, `--muted`, `--menu`, `--shadow`, `--text`). No inline
  color literals.
- Keep the existing save path: intake fields still persist via `PATCH /api/workspaces/:id/intake`
  (`saveIntake`, `ShipmentPanel.tsx:99-112`).
- **Stop at `cd frontend && npm run build` green.**

## Goal

Turn the three plain text inputs (`ShipmentPanel.tsx:242-244`) into proper controls, and add the
new destination-country field:

1. **Incoterms** → native `<select>`, flat list of all 11 Incoterms® 2020 terms.
2. **Транспорт** → native `<select>`, **filtered by the selected Incoterm**.
3. **Країна походження** + **Країна призначення** → a new searchable **`<Combobox>`** (type-ahead on
   Ukrainian AND English names).

---

## 1. Static data module — `frontend/lib/shipmentOptions.ts` (new)

Single source of truth for the option lists and the filter rule. Export:

- `INCOTERMS_2020: { code: string; label: string }[]` — all 11 in canonical order:
  `EXW, FCA, FAS, FOB, CFR, CIF, CPT, CIP, DAP, DPU, DDP`. Label can be
  `"FOB — Free On Board"` etc.
- `TRANSPORT_MODES: { value: string; label: string }[]` — the 8 modes with Ukrainian labels:
  `sea` (Морський), `air` (Авіа), `rail` (Залізничний), `road` (Автомобільний),
  `multimodal` (Мультимодальний), `inland_waterway` (Внутрішні водні шляхи),
  `pipeline` (Трубопровідний), `courier` (Кур'єрський/Експрес).
- `SEA_ONLY_INCOTERMS = new Set(['FAS','FOB','CFR','CIF'])` and a helper
  `transportOptionsFor(incoterm: string): typeof TRANSPORT_MODES` →
  **if `incoterm ∈ SEA_ONLY_INCOTERMS`, return only `sea` + `inland_waterway`; otherwise all 8.**
- `COUNTRIES: { code: string; uk: string; en: string }[]` — the **full ISO 3166-1** list, each with
  its Ukrainian and English name and alpha-2 code (generate the complete ~249-entry list; do not
  truncate). Provide `searchCountries(q: string)` that case-insensitively matches `q` as a prefix or
  substring of **either** `uk` or `en`.

**Value-storage convention (decision — apply consistently):** `origin_country` / `destination_country`
and `transport_mode` are free-text columns. **Store the human-readable value** — the Ukrainian country
name for the two countries, and the `value` slug (e.g. `sea`) for transport, and the Incoterm `code`
(e.g. `FOB`) for incoterm. This keeps `report.ts render()` readable (it prints the raw stored value).
If you prefer ISO alpha-2 for countries, that is a legitimate alternative but then the report must map
codes back to names — flag it rather than storing codes silently.

## 2. Searchable Combobox — `frontend/components/ui/Combobox.tsx` (new)

A lightweight, self-contained type-ahead. Model it on the click-outside + absolute-panel pattern in
`WorkspaceSelector.tsx:19-25, 52-66` (a `useRef` container, `mousedown` listener toggling `open`, a
`.panel`-styled dropdown positioned `absolute; top: calc(100% + 6px)`).

Props (keep minimal):
```ts
{ value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];   // caller maps countries → {value:uk, label:uk}
  onSearch?: (q: string) => { value: string; label: string }[]; // optional custom filter
  placeholder?: string; }
```
Behavior:
- Renders an `<input className="input">` showing the current text; typing filters the list
  (via `onSearch` when provided, else substring match on `label`).
- Clicking an option calls `onChange(option.value)` and closes; clicking outside closes.
- Free-text is allowed (import countries are messy) — on blur, keep whatever the user typed so a
  value not in the list is still saved. (Do not force selection from the list.)
- Basic keyboard support is a nice-to-have (↑/↓/Enter/Esc) but not required for this phase; if you
  add it, keep it simple.

Do **not** build a generic design-system Select in this phase — native `<select>` covers Incoterms
and Transport. Only the country field needs the custom Combobox.

## 3. Wire into `ShipmentPanel.tsx`

- **Form state** — add `destination_country` to the `useState` seed (`:57-63`) and the re-seed
  `useEffect` (`:65-73`): `destination_country: workspace.destination_country ?? ""`.
- **saveIntake** (`:99-112`) — add `body.destination_country = form.destination_country || null;`.
- **Replace the three `Field` rows (`:242-244`)** in the "Параметри постачання" section:
  - Incoterms → `<select className="input">` populated from `INCOTERMS_2020`
    (`<option value="">—</option>` first, then `code → "code — label"`), bound to `form.incoterm`.
  - Транспорт → `<select className="input">` populated from `transportOptionsFor(form.incoterm)`,
    bound to `form.transport_mode`. **On incoterm change**, if the current `transport_mode` is no
    longer in the filtered set, reset it to `""` (and optionally show a small `--muted` hint that the
    Incoterm restricts transport to sea/inland waterway).
  - Країна походження → `<Combobox>` bound to `form.origin_country`, options from `COUNTRIES`
    mapped to `{ value: c.uk, label: c.uk }` with `onSearch={(q)=>searchCountries(q).map(...)}`.
  - **Add Країна призначення** → identical `<Combobox>` bound to `form.destination_country`.
  - Keep the existing `<label style={lbl}>` pattern for each (the `Field` helper at `:361-368` can be
    left in place for other uses, or inline equivalent labels).

Leave `contract_type`, `product_category`, the Responsible select, the Parties section, and the Дії
section untouched.

## 4. Frontend types

`frontend/lib/types.ts` — ensure `destination_country?: string | null` exists on `Workspace`
(added in Phase 1; add it here if Phase 1 hasn't landed yet).

## 5. OPTIONAL add-on — read-only per-document Incoterm (only if in scope for this pass)

The confirmed decision surfaces the already-extracted per-document incoterm **read-only** (editable
per-doc is deferred). **This requires a small backend change** — the files list route
(`src/routes/files.ts`) does NOT currently return extraction fields. If you take this on:
- Backend: join the newest `document_extractions.extracted_fields->>'incoterm'` into the files list
  response (`GET /api/workspaces/:id/files`) as an optional `incoterm` field; update `API_CONTRACT.md`
  and `frontend/lib/types.ts` accordingly.
- Frontend: show it as a muted read-only tag on the file row in `FileTree.tsx` when present.

**Recommendation:** if this grows the diff meaningfully, split it into its own small prompt and keep
Phase 2 to the sidebar dropdowns. Do not add per-document *editing* here.

## Out of scope for Phase 2
- Parties UI/LLM extraction, badges (Phase 3); 2/3-party checklist (Phase 4); Duplicate/Delete +
  status (Phase 5); export promotion (Phase 6); folder merge (Phase 7); icon CSS (Phase 8).
- Any `files.incoterm_override` column or per-document incoterm *editing*.

## Verification
1. `cd frontend && npm run build` — clean.
2. Manual (dev server): open a shipment → the three fields are now dropdowns; selecting
   **FOB/FAS/CFR/CIF** restricts Транспорт to Морський + Внутрішні водні шляхи, and switching back to
   e.g. **DAP** restores all modes. Typing "Кит" in Країна suggests "Китай"; "Germ"/"Нім" suggests
   Німеччина. Both origin and destination save via **Зберегти параметри** and survive a reload
   (round-trips through `PATCH /intake` → `GET /:id`).
3. Confirm a saved value not in the list (free text) is still persisted (combobox doesn't force
   selection).

## Suggested commit (only if asked)
`feat(shipment): Incoterms/Transport dropdowns + country combobox (origin & destination)`
