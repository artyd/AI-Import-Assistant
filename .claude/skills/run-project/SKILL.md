---
name: run-project
description: How to run, build and verify the AI Import Assistant locally or via Docker, seed users, run tests and the smoke test, and troubleshoot boot errors. Use when starting the stack, debugging startup/env/DB/Redis issues, or verifying a change end-to-end.
---

# Running & verifying

## Local dev (needs Postgres + Redis reachable)

```bash
npm install
cp .env.example .env          # set DATABASE_URL, REDIS_URL, ANTHROPIC_API_KEY, JWT_SECRET, CORS_ORIGIN
npm run dev                   # API (tsx watch), :8080
npm run dev:worker            # ingest worker (separate terminal)
npm run seed -- you@x.com pass 'Name'
cd frontend && npm install && npm run dev   # Next.js, relative /api/* paths
```

Every env var, with its default: `src/lib/config.ts` (zod; boot fails fast and
names the offending var).

## Full stack (Docker)

```bash
cp .env.example .env
docker compose up -d --build   # postgres, redis, backend, worker, frontend, logist-mcp
docker compose exec backend node dist/auth/seed.js you@x.com pass 'Name'
docker compose logs -f backend worker
```

Compose derives `DATABASE_URL`/`REDIS_URL` from service names. The public domain
is routed by the host's system Caddy, which is not part of this repo (ADR-0006,
`DEPLOYMENT.md`).

## Verify

- Backend: `npm run typecheck`, `npm test` (vitest, infra-free), `npm run build`
  (must emit `dist/server.js`, `dist/worker/index.js`, `dist/db/schema.sql`,
  `dist/analysis/data/*.json`, the last two copied by `scripts/copy-assets.mjs`).
- Frontend: `cd frontend && npm run typecheck && npm run build && npx playwright test`.
  Specs that need the live API skip unless `PW_BACKEND=1`.
- End-to-end: `EMAIL=... PASSWORD=... npm run smoke` against a running stack
  (`SKIP_CHAT=1` avoids Anthropic cost).

## Troubleshooting

- **Boot exits with an env list** → a required var failed validation in
  `src/lib/config.ts`.
- **`ECONNREFUSED` from pg** → Postgres not reachable. Compose waits on
  healthchecks; local dev doesn't.
- **BullMQ connection warning** → connections need `maxRetriesPerRequest: null`
  (`src/lib/queue/connection.ts`).
- **Every browser POST returns 500, curl works** → a stale `CORS_ORIGIN` in `.env`.
- **SSE 401** → chat is SSE-over-POST (`fetch` + `Authorization`). `/events`
  uses a one-time `?ticket=` from `POST /api/auth/sse-ticket`; a JWT in the
  query string is rejected.
