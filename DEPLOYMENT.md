# Deployment — AI Import Assistant (backend + frontend, one origin)

The **frontend** (Next.js) and the **backend** (this repo's Fastify stack) run on
**the same server** via Docker Compose and are served from **one public domain**.
TLS and domain routing are handled by the **system Caddy on the host**
(`/etc/caddy/Caddyfile`) — this is **not** part of this compose file and is edited
by hand with `sudo`. Because the app and the API share an origin, the browser uses
**relative paths** (`/api/...`) — there is no separate backend URL and no CORS
boundary to cross.

> Vercel is **not** used. Everything runs on our own server.

```
Browser ──HTTPS + SSE──▶  System Caddy (host, :443, /etc/caddy/Caddyfile)
                              │
                              ├─ /api/*  /health ─▶  backend   127.0.0.1:8006  (Fastify, docker)
                              │                          │      │
                              │                      Postgres  Qdrant
                              │                          ▲      ▲
                              │                          └ worker (BullMQ + Redis)
                              │                          │
                              │                      disk volume (storage_data)
                              │
                              └─ everything else ─▶  frontend  127.0.0.1:8007  (Next.js, docker)
```

The compose stack publishes only on `127.0.0.1` (backend `8006`, frontend `8007`);
the host Caddy is the only thing bound to `:80`/`:443`. There is **no `caddy`
service inside this compose file** — ports 80/443 on this server are shared with
other sites, so TLS is terminated once, centrally, by the system Caddy.

## Prerequisites

- A Linux server with Docker + Docker Compose v2 **and** a system Caddy already
  serving other sites on `:80`/`:443`.
- A DNS record for the domain (prod: `ai-import-assistant.duckdns.org`) pointing
  at the server. The system Caddy obtains/renews TLS automatically.
- An **Anthropic API key** and a **Voyage AI key** (embeddings).

## First deploy

```bash
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY, EMBEDDING_API_KEY, JWT_SECRET,
# CORS_ORIGIN (the public domain), and the POSTGRES_* values.

docker compose up -d --build
```

On boot the backend and worker each run migrations (idempotent) and ensure the
Qdrant collection exists. Then wire up the domain in the system Caddy (next
section) and check health through it:

```bash
curl https://ai-import-assistant.duckdns.org/health      # {"status":"ok"}
```

## System Caddy block (edit by hand, with sudo — NOT part of compose)

Append this block to **`/etc/caddy/Caddyfile`** on the host, then reload Caddy.
It sends `/api/*` and `/health` to the backend (with SSE-safe buffering disabled)
and everything else to the Next.js frontend:

```caddyfile
ai-import-assistant.duckdns.org {
	encode zstd gzip

	# API + health check → Fastify backend (docker, localhost-only).
	@backend path /api/* /health
	handle @backend {
		reverse_proxy 127.0.0.1:8006 {
			# Server-Sent Events: never buffer, keep long-lived streams open.
			# This is what lets `token` / `tool_call` / `file_status` events
			# reach the browser incrementally through the proxy.
			flush_interval -1
			transport http {
				response_header_timeout 0
			}
		}
	}

	# Everything else → Next.js frontend (docker, localhost-only).
	handle {
		reverse_proxy 127.0.0.1:8007
	}
}
```

Apply it:

```bash
sudo nano /etc/caddy/Caddyfile          # paste the block above
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Frontend (Next.js, in `frontend/`)

The frontend is a Next.js 15 app (App Router) built as a **standalone** server and
run in the `frontend` compose service (`node server.js` on port 3000, published on
`127.0.0.1:8007`). It talks to the backend over **relative paths** (`/api/...`) —
there is no `NEXT_PUBLIC_API_URL` and no CORS hop, because the host Caddy serves
both from one origin. `docker compose up -d --build` builds and starts it.

- **Chat** is SSE-over-`POST` → `fetch` + a `ReadableStream` reader (sets the
  `Authorization` header). **Live file status** is SSE-over-`GET` → the native
  `EventSource` with `?access_token=<jwt>`.
- **Local dev without Caddy:** run the backend (`npm run dev` in the repo root),
  then `cd frontend && DEV_API_PROXY=http://localhost:8080 npm run dev`. The
  `DEV_API_PROXY` env turns on a dev-only Next rewrite so `/api/*` reaches the
  backend; in production it is unset and Caddy does the routing.

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
a live stack with a seeded user (through the public domain, or straight at the
localhost backend port):

```bash
BASE_URL=https://ai-import-assistant.duckdns.org \
EMAIL=user@agroup95.com PASSWORD='s3cret' \
npm run smoke
```

Locally against `npm run dev` the default `BASE_URL=http://localhost:8080`
works. `SKIP_CHAT=1` skips the Anthropic-billed chat step; `INDEX_TIMEOUT_MS`
tunes how long to wait for indexing. Exit code is non-zero if any check fails.

## Operations

- **Logs:** `docker compose logs -f backend worker frontend`
- **Scale indexing throughput:** `docker compose up -d --scale worker=3`
- **Redeploy after code changes:** `docker compose up -d --build backend worker frontend`
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
| `CORS_ORIGIN` | ✅ | — | Public origin; same-origin now, so mostly a formality |
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
