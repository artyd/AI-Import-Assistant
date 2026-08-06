---
name: run-project
description: How to run, build, and verify the AI Import Assistant backend locally or via Docker, seed users, run the smoke test, and troubleshoot common boot errors. Use when starting the stack, debugging startup/env/DB/Qdrant/Redis issues, or verifying a change end-to-end.
---

# Running & verifying the backend

## Local dev (needs Postgres + Redis + Qdrant reachable)

```bash
npm install
cp .env.example .env          # set the three service URLs + keys for local
npm run dev                   # API (tsx watch)
npm run dev:worker            # indexing worker (separate terminal)
npm run seed -- you@x.com pass 'Name'
```

Env for local (outside compose) — set explicitly:
`DATABASE_URL`, `REDIS_URL`, `QDRANT_URL`, plus `ANTHROPIC_API_KEY`,
`EMBEDDING_API_KEY`, `JWT_SECRET`, `CORS_ORIGIN`. Full list + defaults:
`src/config.ts` (zod schema — boot fails fast with the offending var).

## Full stack (Docker)

```bash
cp .env.example .env          # secrets + API_DOMAIN + CORS_ORIGIN + POSTGRES_*
docker compose up -d --build
docker compose exec backend node dist/auth/seed.js you@x.com pass 'Name'
docker compose logs -f backend worker
```

Compose derives `DATABASE_URL`/`REDIS_URL`/`QDRANT_URL` from service names, so
they are NOT set in `.env`. Backend + worker share the `storage_data` volume.

## Verify

- `npm run typecheck` — always run before finishing a change.
- `npm run build` — must emit `dist/server.js`, `dist/worker/index.js`,
  `dist/db/schema.sql` (schema is copied by `scripts/copy-assets.mjs`).
- `npm run smoke` — end-to-end (health→login→workspace→upload→index→chat→delete).
  Needs a running stack + seeded user: `EMAIL=... PASSWORD=... npm run smoke`.
  `SKIP_CHAT=1` avoids Anthropic cost.

## Troubleshooting

- **Boot exits with an env list** → a required var failed zod validation
  (`src/config.ts`). Fix `.env`.
- **`pg`/`ECONNREFUSED`** → Postgres not up/reachable; in compose it waits on
  healthchecks, locally it doesn't.
- **Qdrant dimension mismatch on upsert** → `EMBEDDING_MODEL` dimension ≠
  collection size; recreate the `documents` collection.
- **BullMQ connection warning** → connections use `maxRetriesPerRequest: null`
  (`src/queue/connection.ts`); required for workers.
- **SSE not streaming through the proxy** → Caddy uses `flush_interval -1`
  (`Caddyfile`); don't add buffering.
- **Chat 401 on the browser** → chat is SSE-over-POST; the FE must use
  `fetch`+`ReadableStream` (sets `Authorization`), not native `EventSource`.
  The `/events` channel is GET and uses `?access_token=`.
