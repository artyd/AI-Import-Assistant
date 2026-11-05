# 008 · Поставки — a separate shipment register on our site

Status: ready-for-agent

## Why

Management asked to bring the team's shipment register («Поставки», until now a
separate site) into our product. People who follow the register must not get
Штурман. So Поставки is a second app on the same site, with its own entry, and
Штурман stays behind its PIN.

## Decisions (interview 2026-11-05)

- One domain, two paths: `/supply` is Поставки, `/workspaces` is Штурман. `/`
  is the shared entry: the Поставки entry by default, a corner mark morphs to
  the Штурман PIN gate and back.
- No accounts in Поставки. **Viewing is open** to anyone with the link.
  **Editing needs the Штурман PIN** (`ACCESS_CODE`). A signed-in Штурман session
  may edit too.
- The PIN unlock for Поставки returns a **supply-scoped token** signed with a
  different key, so it never opens a Штурман route.
- Data lives in our Postgres (`supply_*` tables), never in the browser.
- One-time import of the old site's data (`/api/workspace`), then the old site
  goes away. The team Google Sheet sync is untouched and keeps running in
  parallel (ADR-0009).
- UI in Ukrainian; record text stays as typed.
- Screens: register list by category, one-screen month calendar with a week
  agenda, archive, change history with undo, dictionaries (stages, route
  templates, categories, extra fields). Card in a right drawer. Excel export,
  30 s auto-refresh. Deadlines are shown on screen only, no notifications.
- Deleting a shipment is not offered; it goes to the archive. Every write is a
  history entry that can be undone.
- Штурман's agent can read the register (read-only tool).

## Data

`supply_shipments`: `id`, `legacy_id`, `name`, `category`, `action` (next
step), `note`, `archived`, `steps` (JSON `[{id,name,plan,actual,state,note}]`,
`state ∈ active|done|pending`, dates `YYYY-MM-DD` or empty), `custom` (JSON of
extra-field values), `position`, `created_at`, `updated_at`.

`supply_settings` (one row): `stages`, `categories`, `fields`
(`[{id,name,type}]`), `templates` (`[{id,name,stages[]}]`).

`supply_history`: `id`, `at`, `actor`, `text`, `shipment_id`, `before`,
`after` (JSON snapshots), `undone_at`. Imported old history has no snapshots
and cannot be undone.

## API

See `API_CONTRACT.md` § Поставки. Reads are public; writes need the Штурман
JWT or the supply token from `POST /api/supply/unlock`.

## Import

`npm run supply:import` (or `node dist/supply/importLegacy.js [url|file]` in the
container) pulls the old site's workspace JSON and fills empty tables. It
refuses to run twice unless `--force`.
