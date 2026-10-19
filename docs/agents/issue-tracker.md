# Issue tracker: local markdown in `docs/specs/`

Specs and tickets for this repo are markdown files committed under `docs/specs/`.
GitHub Issues are not used.

## Conventions

- One spec per feature: `docs/specs/NNN-slug.md`, where `NNN` is the next free
  three-digit number (scan `docs/specs/` for the highest one and add 1).
- Tickets for that spec: one file each at `docs/specs/NNN-slug/NN-slug.md`,
  numbered from `01`. Never put several tickets in one combined file.
- Assets that belong to the spec (mockups, fixtures) go in `docs/specs/NNN-slug/`
  next to the tickets, e.g. `docs/specs/005-instruction-builder-and-report/mockups/`.
- Triage state is a `Status:` line near the top of each ticket, using the strings
  in `triage-labels.md`.
- Comments and conversation history go at the bottom of the file under a
  `## Comments` heading.
- Audits and research reports are not specs. They live in `docs/audits/YYYY-MM-DD-slug.md`.

## When a skill says "publish to the issue tracker"

Create the spec file `docs/specs/NNN-slug.md`, or a ticket file under
`docs/specs/NNN-slug/`, creating the directory if needed.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user normally passes the path or the
`NNN`/`NN` number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `docs/specs/NNN-slug/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `docs/specs/NNN-slug/NN-slug.md`, numbered from `01`, with the
  question in the body. A `Type:` line records the ticket type
  (`research`/`prototype`/`grilling`/`task`), and a `Status:` line records
  `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked
  once every file it lists is `resolved`.
- **Frontier**: the open, unblocked, unclaimed files in `docs/specs/NNN-slug/`.
  The lowest number wins.
- **Claim**: set `Status: claimed` and save before starting any work.
- **Resolve**: append the answer under an `## Answer` heading, set
  `Status: resolved`, then add a context pointer (gist + link) to the map's
  Decisions-so-far.
