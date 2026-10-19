# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**: one `GLOSSARY.md` at the root and one `docs/adr/`.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read the ADRs that touch the area you're about to work in.

## File structure

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/          0001-single-agent.md, 0002-markdown-at-ingest-no-embeddings.md, …
│   ├── specs/        NNN-slug.md + NNN-slug/NN-*.md (see issue-tracker.md)
│   └── audits/       dated audit / research reports
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (Markdown at ingest, no embeddings), but worth reopening because…_
