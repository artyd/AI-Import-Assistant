# AI Import Assistant — backend

Backend for an IDE-style workspace for **Ukrainian import/customs logistics**. A
single Claude agent **"Штурман"** reconciles shipment documents (invoice vs PO vs
packing list), tracks document-package completeness, and suggests УКТ ЗЕД codes.
The frontend is a Next.js app that lives in **`frontend/`** in this repo; backend
and frontend are served from **one origin** by the host's system Caddy (backend at
`127.0.0.1:8006` for `/api/*` + `/health`, frontend at `127.0.0.1:8007` for the
rest — see `DEPLOYMENT.md`). The wire contract is `API_CONTRACT.md`; the browser
uses **relative paths** (`/api/...`), so there is no separate backend URL. Vercel
is not used.

> The `AI Import Assistant prototype.zip` at the root is a **static design mock**
> (HTML + a React/Babel canvas runtime), NOT a functional app. Use it only for UI
> data shapes; `API_CONTRACT.md` is the source of truth for the wire contract.

## Hard constraints (do not violate)

- **Single agent only.** One Claude conversation per chat, using tools. No
  multi-agent orchestration / sub-agent hand-off in the product runtime.
- **Hybrid retrieval — both.** The agent must keep BOTH `search_documents`
  (semantic, Qdrant) and `read_file` (precise, on-demand extraction). The model
  chooses at runtime; never hardcode a fixed retrieval pipeline.
- **Anthropic key server-side only** (`src/anthropic/client.ts`). The browser
  never calls Anthropic/Voyage directly.
- **Model:** `claude-opus-4-8` with `thinking: { type: 'adaptive' }`.

## Stack & layout (everything flat in the repo root)

Node 20 + TypeScript (ESM, `NodeNext`) · Fastify 5 · `@anthropic-ai/sdk` ·
PostgreSQL (`pg`) · Qdrant · Voyage embeddings (behind `EmbeddingProvider`) ·
BullMQ + Redis worker · Caddy · Docker Compose.

```
src/
  server.ts            Fastify bootstrap: CORS, rate-limit, multipart, routes, boot
  config.ts            zod-validated env (fails fast)
  db/                  pool, schema.sql, migrate
  auth/                passwords (bcrypt), jwt, authenticate hook, seed script
  routes/              auth, workspaces, files, chat (SSE), conversations, events (SSE)
  agent/               loop.ts (tool-use loop), tools.ts (3 tools), systemPrompt.ts
  services/            storage, extract/ (pdf|docx|xlsx|csv), embeddings/, qdrant, conversations, workspaceAccess
  queue/               BullMQ queue + Redis connection
  events/              fileStatus pub/sub (live indexing status)
  worker/index.ts      indexing worker: extract → chunk → embed → Qdrant → status
domain/folders.ts      folder skeleton + file-type inference
scripts/               copy-assets.mjs (build), smoke-test.mjs
docker-compose.yml  Caddyfile  .env.example  Dockerfile
API_CONTRACT.md  DEPLOYMENT.md
```

## Commands

- `npm run dev` / `npm run dev:worker` — hot-reload server / worker (tsx)
- `npm run build` — tsc + copy schema.sql into dist
- `npm run typecheck` — `tsc --noEmit` (run before finishing any change)
- `npm run migrate` — apply schema (idempotent)
- `npm run seed -- <email> <password> [name]` — create a user (no public signup)
- `npm run smoke` — end-to-end API smoke test (needs a running stack + seeded user)
- `docker compose up -d --build` — full stack (postgres, redis, qdrant, backend, worker, caddy)

## Conventions

- **ESM imports of local files MUST end in `.js`** (e.g. `import { x } from './y.js'`)
  even though the source is `.ts` — this is `NodeNext` resolution.
- Strict TS incl. `noUncheckedIndexedAccess`. Validate all request bodies with `zod`.
- **Terminology:** the brief's *workspace* == the prototype's *shipment*
  (`Постачання`; fields `number`/`supplier`/`status`). REST paths use `/api/workspaces`.
- **File status:** backend emits `queued|indexing|ready|error`; the frontend maps
  `ready → done`. `error` carries `errorReason`.
- **SSE events** (chat): `token`, `tool_call`, `tool_result`, `done`, `error`;
  (events channel): `file_status`. Keep these stable — the FE depends on them.
- Every workspace-scoped route calls `getOwnedWorkspace(userId, id)` and 404s on miss.

## Where to add things

- **A new REST route** → `src/routes/<name>.ts` (async plugin), register in
  `server.ts`, add `authenticate` preHandler, scope by `getOwnedWorkspace`.
- **A new agent tool** → add a definition to `toolDefinitions` and a handler in
  `executeTool` (`src/agent/tools.ts`); it returns `{ result, summary, citations }`.
- **A new embedding vendor** → implement `EmbeddingProvider`
  (`src/services/embeddings/`) and branch in `getEmbeddingProvider()`.
- **A new file format** → extend `extractText` (`src/services/extract/index.ts`)
  and `inferFileType` (`domain/folders.ts`) + the allow-list in `storage.ts`.

Out of scope (documented v2): OCR for images; native structured agent blocks
(diff-tables/checklists arrive as Markdown in the answer for now).
