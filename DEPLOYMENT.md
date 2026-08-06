# Deployment — AI Import Assistant backend

The **frontend** is hosted on **Vercel**. The **backend** (this repo — all files
live in one directory) runs on **our own server** via Docker Compose, behind
**Caddy** (automatic HTTPS). They live on different origins; CORS + SSE are
configured to work across that boundary.

```
Vercel (Next.js)  ──HTTPS + SSE──▶  Caddy (TLS)  ──▶  Fastify backend ──▶ Anthropic
                                                       │      │
                                                   Postgres  Qdrant
                                                       ▲      ▲
                                                       └ worker (BullMQ+Redis)
                                                       │
                                                   disk volume (storage_data)
```

## Prerequisites

- A Linux server with Docker + Docker Compose v2.
- A DNS `A`/`AAAA` record for `API_DOMAIN` (e.g. `api.ourdomain.com`) pointing at
  the server, and ports **80** + **443** open (Caddy needs both for ACME/TLS).
- An **Anthropic API key** and a **Voyage AI key** (embeddings).

## First deploy

```bash
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY, EMBEDDING_API_KEY, JWT_SECRET,
# API_DOMAIN, CORS_ORIGIN, and the POSTGRES_* values.

docker compose up -d --build
```

On boot the backend and worker each run migrations (idempotent) and ensure the
Qdrant collection exists. Check health:

```bash
curl https://api.ourdomain.com/health      # {"status":"ok"}
```

## Create the first user (no public signup)

Users are admin-seeded:

```bash
docker compose exec backend node dist/auth/seed.js user@agroup95.com 's3cret' 'Ім'"'"'я'
```

Then `POST /api/auth/login` returns a JWT.

## Smoke test

A dependency-free script exercises the whole flow (health → login → workspace →
folder skeleton → CSV upload → indexing → chat SSE → conversations → delete),
including negative checks (401 without a token, `.exe` rejected). Run it against
a live stack with a seeded user:

```bash
BASE_URL=https://api.ourdomain.com \
EMAIL=user@agroup95.com PASSWORD='s3cret' \
npm run smoke
```

Locally against `npm run dev` the default `BASE_URL=http://localhost:8080`
works. `SKIP_CHAT=1` skips the Anthropic-billed chat step; `INDEX_TIMEOUT_MS`
tunes how long to wait for indexing. Exit code is non-zero if any check fails.

## The one thing the Vercel project needs

Set a single environment variable on the Vercel project — the backend's base URL:

```
NEXT_PUBLIC_API_URL=https://api.ourdomain.com
```

The frontend prefixes every request with this. Nothing else about Vercel needs
to change here. Notes for the frontend team (full detail in `API_CONTRACT.md`):

- Send `Authorization: Bearer <jwt>` on all calls except login.
- **Chat is SSE over `POST`** → use `fetch` + a `ReadableStream` reader (not the
  native `EventSource`, which can't POST or set headers).
- The **live file-status** channel (`GET …/events`) is SSE over `GET` → the
  native `EventSource` works; authenticate with `?access_token=<jwt>`.
- CORS auto-allows `CORS_ORIGIN` plus that project's Vercel **preview**
  deployments (`https://<project>-<hash>.vercel.app`).

## Operations

- **Logs:** `docker compose logs -f backend worker`
- **Scale indexing throughput:** `docker compose up -d --scale worker=3`
- **Redeploy after code changes:** `docker compose up -d --build backend worker`
- **Backups:** persist the named volumes `postgres_data`, `qdrant_data`, and
  `storage_data` (raw files). `redis_data` is a transient job queue.
- **Rotate secrets:** edit `.env`, then `docker compose up -d`.

## Environment variables (backend)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ANTHROPIC_API_KEY` | ✅ | — | Claude API (server-side only) |
| `EMBEDDING_API_KEY` | ✅ | — | Voyage AI embeddings |
| `DATABASE_URL` | ✅ | — | PostgreSQL (derived in compose) |
| `QDRANT_URL` | — | `http://localhost:6333` | Qdrant (derived in compose) |
| `REDIS_URL` | — | `redis://localhost:6379` | BullMQ (derived in compose) |
| `JWT_SECRET` | ✅ | — | Session signing (≥16 chars) |
| `CORS_ORIGIN` | ✅ | — | Production Vercel origin(s) |
| `STORAGE_DIR` | — | `./storage` | On-disk file storage root |
| `ANTHROPIC_MODEL` | — | `claude-opus-4-8` | Chat model |
| `EMBEDDING_MODEL` | — | `voyage-3` | Multilingual (Ukrainian) embeddings |
| `MAX_UPLOAD_BYTES` | — | `26214400` | Per-file upload cap (25 MB) |
| `CHAT_RATE_MAX` / `CHAT_RATE_WINDOW` | — | `30` / `1 minute` | Per-user chat rate limit |
| `QDRANT_API_KEY` | — | — | If Qdrant auth is enabled |

## Out of scope for v1 (documented v2 additions)

- **OCR** for scanned images — image files are stored and marked `ready` but not
  indexed (no text layer).
- **Native structured agent blocks** — reconciliation diff-tables / completeness
  checklists currently arrive as Markdown inside the answer; a typed
  `checks[]`/`diff{}` schema can replace that later without changing the transport.
