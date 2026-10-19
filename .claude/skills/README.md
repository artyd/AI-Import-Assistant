# Project skills

Two kinds of skills live here:

- **Project skills** (written for this repo): `indexing-pipeline/`, `run-project/`.
  Project slash-commands live in `../commands/` (`/verify`, `/smoke`, `/add-route`,
  `/add-agent-tool`).
- **Vendored skills** from [mattpocock/skills](https://github.com/mattpocock/skills):
  every folder of `skills/engineering/` and `skills/productivity/`, copied as plain
  files so they can be adapted here.

## Upstream

- Source: `https://github.com/mattpocock/skills`
- Commit: `49dd158d1076134a641b33efb035946536778336` (vendored 2026-10-19)

## Renamed on import

These names clash with Claude Code built-in commands, so the folder, the `name:`
field and every cross-reference in the other vendored skills carry an `mp-` prefix:

| Upstream      | Here             |
| ------------- | ---------------- |
| `code-review` | `mp-code-review` |
| `research`    | `mp-research`    |
| `prototype`   | `mp-prototype`   |

Left unchanged on purpose: wayfinder ticket types (`research`/`prototype`) and the
`/prototype/<name>` URL route / `prototype/<name>` branch names.

## Repo configuration the skills read

`docs/agents/` (issue tracker = local markdown in `docs/specs/`, triage labels,
domain-doc layout), `GLOSSARY.md`, `docs/adr/`. See the `## Agent skills` block in
`CLAUDE.md`.

## Updating

1. `git clone --depth 1 https://github.com/mattpocock/skills /tmp/mp-skills`
2. Diff each folder against `/tmp/mp-skills/skills/{engineering,productivity}/<name>`
   and copy over what changed, keeping local adaptations.
3. Re-apply the renames above (folder, `name:`, references such as `/code-review`,
   ``Skill tool with "code-review"``, `` the `code-review` skill ``).
4. Bump the commit hash in this file.
