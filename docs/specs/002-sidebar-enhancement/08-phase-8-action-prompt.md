# Action Prompt — Phase 8: Icon-centering CSS fix

> Standalone action prompt derived from the Shipment/Journal sidebar audit
> (`read-only-audit-wild-milner.md`). Smallest phase — one CSS rule. Frontend only.

## Role & constraints

Working in the **AI Import Assistant** frontend (`C:\Projects\Артем\AI Import Assistant\frontend`).
Pure CSS change; no logic. **Stop at `cd frontend && npm run build` green.**

## Diagnosis (already confirmed)

Hover action icons (upload/move/versions/rename/delete) render in the **top-left** of their button
instead of centered. Root cause is in **`frontend/app/globals.css:158-166`**:

```css
.btn-icon {
  height: 30px;
  width: 30px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--icon-fg-muted);
}
```

`.btn-icon` sets size/color but **no `display`, `align-items`, or `justify-content`**. These buttons use
`className="btn-icon row-action"` (e.g. `FileTree.tsx:124-131, 252-260, 329-357`;
`app/workspaces/page.tsx:159-167`), NOT `"btn btn-icon"`, so they never inherit the centering that the
general `.btn` class provides (`globals.css:125-141`). `.row-action` is hidden by `display: none`
(`:340`) and flipped to `display: inline-flex` on hover (`:344`) — turning the button into a flex
container with the browser defaults `justify-content: flex-start` / `align-items: stretch`, which pins
the fixed-size `<svg>` to the top-left.

## Fix

Add flex centering to `.btn-icon` so it centers its `<svg>` regardless of who sets `display`:

```css
.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  width: 30px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--icon-fg-muted);
}
```

Notes:
- `.row-action`'s hover rule (`:344`) overrides `display` to `inline-flex` anyway; adding
  `align-items` / `justify-content` on `.btn-icon` is what actually centers the icon in both the hidden
  and hover states. Setting `display: inline-flex` here also fixes any always-visible `.btn-icon`
  (e.g. the folder collapse chevron, `FileTree.tsx:93-106`) to use the same centered box.
- Do not change `.row-action` (`:340-350`) or the `.btn` class. One rule edit is sufficient.

## Out of scope
- Any JSX/markup change (the fix is purely in `.btn-icon`).
- Restyling buttons, hover backgrounds, or icon sizes.

## Verification
1. `cd frontend && npm run build` clean.
2. Manual (dev server): hover a folder row and a file row in the document browser (`FileTree`) — the
   action icons are **centered** in their 30×30 buttons (both axes), not top-left. Check the workspaces
   list page `row-action` icons too (`app/workspaces/page.tsx`). Confirm the always-visible folder
   chevron still looks correct.
3. Optional: touch/`@media (hover:none)` path (`globals.css:346-350`) — icons also center there.

## Suggested commit (only if asked)
`fix(ui): center hover action icons in .btn-icon (flex align/justify)`
