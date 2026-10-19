# AI Import Assistant

A workspace for Ukrainian import logistics in which one Claude agent, **Штурман**, checks a shipment's documents against each other, tracks how complete the document package is, gives advisory УКТ ЗЕД codes, and tracks cargo. Domain terms are in `GLOSSARY.md`; decisions and their reasons are in `docs/adr/`.

## Map

```
src/                     backend: Node 20 + TS (ESM/NodeNext), Fastify 5, pg, BullMQ
  server.ts              entry → dist/server.js: builds Fastify, registers route plugins (order matters)
  worker/index.ts        entry → dist/worker/index.js: ingest worker + repeatable jobs
  db/                    pool, schema.sql, migrate (dist/db/migrate.js), one-off migrations
  auth/                  JWT, bcrypt, SSE tickets, login throttle, seed (dist/auth/seed.js), auth/users routes
  lib/                   infrastructure: config (zod env), anthropic client, BullMQ queues, events, sse, storage, pdf, zip, mime
  agent/                 Штурман: loop.ts, systemPrompt.ts, tools.ts (definitions + dispatcher), tools/<area>.ts handlers
  chat/                  chat routes for the 3 chat kinds, conversations + history
  shipments/             shipments + collections, ownership checks, folder skeleton, status, auto-context
  documents/             file upload/preview/export routes, classify, versions, artifacts
  ingest/                file → Markdown (vision), full-text sections, field extraction, retry sweep
  reconciliation/        completeness, discrepancies (reconcile.ts), risks, parties, verification
  customs/               logist-mcp client (qdpro, NBU, PubChem, dual-use), drug registry
  instruction/ report/   supplier instruction constructor; one-page management report
  analysis/              consolidated analysis engine + data/*.json; byok/ (user AI keys)
  hub/ sheet/            logistics hub (tracks, ports, lines, routes); team Google Sheet sync + calendar
  news/ notifications/ mcp/   RSS news; in-app bell + reminders; public MCP endpoint
  <area>/*.routes.ts     a Fastify route plugin; <area>/__tests__/*.spec.ts vitest
frontend/                Next.js 15 app (own package): app/ routes, components/<area>/, lib/ (api, types, stores)
logist-mcp/              internal Python service: qdpro/NBU/PubChem scrapers over plain REST
eval/                    golden-set eval for extraction + reconciliation (npm run eval:golden)
scripts/                 build asset copy, smoke test, drug-registry ingest, grounding eval
docs/                    adr/ decisions · specs/ specs + tickets · audits/ dated reports · agents/ skill config
API_CONTRACT.md          wire contract (REST + SSE) the frontend depends on
DEPLOYMENT.md            server setup, host Caddy block, env
```

`AI Import Assistant prototype.zip` is a static design mock (HTML + canvas runtime). Use it for UI data shapes only.

## Workflow

1. **Spec**: for anything bigger than a fix, write or extend `docs/specs/NNN-slug.md` (tickets in `docs/specs/NNN-slug/`). Use the GLOSSARY's terms.
2. **Small changes**: put new code in its area folder.
   - Route: `src/<area>/<name>.routes.ts`, then register it in `server.ts` and document it in `API_CONTRACT.md` (`/add-route`).
   - Agent tool: definition in `agent/tools.ts`, handler in `agent/tools/<area>.ts` (`/add-agent-tool`).
   - File format: `convertToMarkdown` + `inferFileType` + the allow-list in `lib/storage.ts`.
3. **Check**: `npm run typecheck && npm test && npm run build` for the backend (`/verify`), and `cd frontend && npm run typecheck && npm run build && npx playwright test` for the frontend. Run `npm run eval:grounding` when you touch the prompt or tools.
4. **Commit** on `main` and push only when asked. A push to `main` can deploy to production (see Deploy).

## Invariants

- **One agent, tools only** (ADR-0001). The chat kinds change the prompt and the tools; they never add agents.
- **Both retrieval tools stay**: `search_documents` (Postgres FTS) and `read_file` (the whole Markdown). Files become Markdown once, at ingest, and there is no embedding vendor (ADR-0002).
- **Grounding rules** are a hard contract in `agent/systemPrompt.ts` (ADR-0003, ADR-0004):
  1. Call `get_missing_context` before supplier instructions, discrepancies, HS suggestions or reports, and ask the user instead of assuming.
  2. Verdicts come from tools (`get_checklist`, `get_discrepancies`, `generate_report`). Retrieval tools only locate text.
  3. HS codes are advisory: give several candidates and say that a specialist confirms. Rates, restrictions and required documents come from qdpro via logist-mcp; the static tables in `analysis/data` are a fallback the agent must name.
  4. Empty data means saying "no data", never guessing.
- **User portrait**: a UA trading-company import specialist who mostly ships chemical/pharma **substances**. Any other product form must be clarified.
- **Model**: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) with adaptive thinking. Never force `tool_choice` (Sonnet 5.5 returns 400); preserved-thinking models need `block_binding: drop_block`.
- **The Anthropic key stays server-side** (`lib/anthropic/client.ts`). BYOK keys serve consolidated analysis only (ADR-0011).
- **Wire contract is frozen**: chat SSE `token|tool_call|tool_result|done|error`, events SSE `file_status`, file status `queued|indexing|ready|error` (the frontend shows `ready` as `done`). Change it only together with `API_CONTRACT.md`.
- **Access**: every shipment-scoped route calls `getOwnedWorkspace(userId, id)` and returns 404 on a miss. SSE authenticates with one-time tickets, never a JWT in the URL (ADR-0007). `/api/mcp` is deliberately open (ADR-0008).
- **Code**: local ESM imports end in `.js`. Strict TS with `noUncheckedIndexedAccess`. Every request body is validated with zod. "Workspace" in code means "shipment" (Постачання).
- **Team sheet is read-only**: never write to it, and never commit real sheet rows (ADR-0009).

## Deploy

CI (`.github/workflows/ci.yml`) runs on every push to `main`. When it is green, `deploy.yml` deploys over SSH, but only if the repo variable `DEPLOY_ENABLED=true`. Otherwise deploy by hand: on `alliance-server` run `cd /opt/AI-Import-Assistant && git pull && docker compose up -d --build backend worker frontend`. Migrations run on boot. Host Caddy and `.env` are covered in `DEPLOYMENT.md`.

## Agent skills

Vendored mattpocock skills live in `.claude/skills/` (see its `README.md`); `code-review`, `research` and `prototype` are installed as `mp-*`. Project skills: `indexing-pipeline`, `run-project`. Project commands: `/verify`, `/smoke`, `/add-route`, `/add-agent-tool`.

### Issue tracker

Specs and tickets are local markdown: `docs/specs/NNN-slug.md` + `docs/specs/NNN-slug/NN-*.md`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), written as a `Status:` line. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.
