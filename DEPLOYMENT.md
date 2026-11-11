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
                              │                          │
                              │                      Postgres (data + full-text search)
                              │                          ▲
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
- An **Anthropic API key** (the only AI vendor — Claude reads every document).

## First deploy

```bash
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY, JWT_SECRET,
# and the POSTGRES_* values. (CORS_ORIGIN is optional — same-origin needs none.)

docker compose up -d --build
```

On boot the backend and worker each run migrations (idempotent). Then wire up the domain in the system Caddy (next
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
	@backend path /api/* /health /health/*
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

## Поставки: one-time import of the old register (spec 008)

After the first deploy with `/supply`, pull the old site's data once:

```bash
docker compose exec backend node dist/supply/importLegacy.js
```

It reads the old site's `/api/workspace` (pass another URL or a JSON file path as
the first argument) and refuses to run when the register already has shipments;
`--force` updates the imported rows in place. Editing `/supply` needs the
Штурман PIN (`ACCESS_CODE`).

## Drug-registry mirror (Phase 6 — offline registration cross-check)

The registry check (validity / manufacturer / marketing-authorization holder vs
documents) runs against a LOCAL copy of the State Register of Medicinal Products
(data.gov.ua, CC-BY, quarterly). Populate / refresh it:

```bash
# Quick seed of one validated record (demo/test — no download):
docker compose exec backend node scripts/ingest-drug-registry.mjs --seed

# Full ingest — download the current snapshot and load ~16.5k registrations:
docker compose exec backend node scripts/ingest-drug-registry.mjs
# …or from a local file / custom URL:
docker compose exec backend node scripts/ingest-drug-registry.mjs /path/reestr.csv
docker compose exec backend node scripts/ingest-drug-registry.mjs --url <csv-url>
```

The CSV is `;`-delimited, Windows-1251 — the script transcodes it. Re-running is
idempotent (upsert by registration number). Schedule quarterly to stay current.
Optional env `REGISTRY_CSV_URL` overrides the default download URL.

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

### What CI runs (no manual release check)

`.github/workflows/ci.yml` also runs, on every PR/push to `main` (and on `ci/**`
branches or by hand via *Run workflow*):

- **`e2e`** — builds the frontend, serves it with `next start -p 3100` and runs
  `npx playwright test --project=desktop-chromium` (backend-dependent specs self-skip).
- **`full-stack`** — brings up the production compose with `docker-compose.ci.yml`
  (a deterministic **mock Anthropic API**, `scripts/mock-anthropic.mjs`, so no key and
  no cost; tracking/news/sheet pollers off; a CI Caddy on `http://localhost:8088`
  with the same `/api/*`+`/health` → backend split), seeds a user, runs this smoke
  test **with chat on**, then Playwright with `PW_BACKEND=1`. Logs and the
  Playwright report are uploaded on failure.

Same thing locally (needs Docker):

```bash
printf 'POSTGRES_USER=aia
POSTGRES_PASSWORD=ci
POSTGRES_DB=aia
JWT_SECRET=ci-jwt-secret-0123456789abcdef
CORS_ORIGIN=http://localhost:8088
ANTHROPIC_API_KEY=ci-dummy-key
' > .env
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --build --wait
docker compose -f docker-compose.yml -f docker-compose.ci.yml exec -T backend node dist/auth/seed.js ci@example.com ci-password-123
BASE_URL=http://localhost:8088 EMAIL=ci@example.com PASSWORD=ci-password-123 node scripts/smoke-test.mjs
cd frontend && PW_BACKEND=1 PW_BASE_URL=http://localhost:8088 npx playwright test --project=desktop-chromium
```

(Use a throwaway `.env`, not the production one.) Deploys stay manual or via `deploy.yml`.

## Operations

- **Logs:** `docker compose logs -f backend worker frontend`
- **Scale indexing throughput:** `docker compose up -d --scale worker=3`
- **Redeploy after code changes:** `docker compose up -d --build`
- **Auto-deploy (CI):** on every push to `main` the **CI** workflow
  (`.github/workflows/ci.yml`, typecheck + build + test) runs; only when it passes
  does **`.github/workflows/deploy.yml`** fire (via `workflow_run`) — it SSHes into
  this server, runs `git reset --hard origin/main`, and rebuilds the stack. So a
  red build is never deployed. Deploy stays inert until you configure it — run
  **`bash scripts/setup-deploy.sh`** once (generates a deploy key, stores the
  `DEPLOY_*` GitHub secrets, and sets the `DEPLOY_ENABLED=true` repo variable).
- **Backups:** see [Backups & restore](#backups--restore) below.
- **Rotate secrets:** edit `.env`, then `docker compose up -d`.

## Backups & restore

Scripts live in `scripts/ops/` (bash, Docker Compose v2). CI
(`.github/workflows/backup-restore.yml`) runs the same scripts through a full
backup → wipe → restore → compare cycle on every push to `main`.

**What is backed up** (into `/var/backups/ai-import-assistant/<UTC yyyy-mm-dd_HHMMSS>/`):

| File | Content |
|------|---------|
| `db.dump` | `pg_dump -Fc` of the Postgres database (`postgres_data`) |
| `storage.tar.gz` | the whole `storage_data` volume: uploaded files + derived artifacts |
| `manifest.json` | time, git commit, sizes, sha256 of both files, storage file count, row counts of `users, workspaces, folders, files, conversations, messages` |

**What is not backed up:** `redis_data` — it only holds BullMQ queues, which are
rebuilt (the retry sweep re-queues unfinished files), so losing it loses no user data.
`logist_cache` is a re-downloadable cache. `.env` holds secrets and is **not** in the
backup: keep a copy in a password manager, you need it for disaster recovery.

A backup is built in `<name>.partial` and renamed only when complete, so a crashed run
never looks like a good backup. Only the newest `BACKUP_KEEP_DAILY` (14) complete
backups are kept. Every run writes `/var/backups/ai-import-assistant/last-status.json`:
`{"ok":true,"at":"…","backup":"…"}` or `{"ok":false,"at":"…","error":"…"}`; on failure
the script also exits non-zero and prints the error to stderr (so it lands in the log).
There is no push alert — see "Checking it ran" below.

### Install the daily job (03:15 server time)

On `alliance-server`, once:

```bash
cd /opt/AI-Import-Assistant && git pull
sudo bash scripts/ops/backup.sh            # first run by hand; prints "backup OK: …"
sudo tee /etc/cron.d/ai-import-backup >/dev/null <<'EOF'
15 3 * * * root cd /opt/AI-Import-Assistant && BACKUP_RCLONE_REMOTE=gdrive:ai-import-backups bash scripts/ops/backup.sh >> /var/log/ai-import-backup.log 2>&1
EOF
```

(Leave out `BACKUP_RCLONE_REMOTE=…` until the offsite remote below exists. `BACKUP_*`
variables can alternatively go into `/opt/AI-Import-Assistant/.env`.) Optional
`/etc/logrotate.d/ai-import-backup`: `/var/log/ai-import-backup.log { monthly rotate 6 compress missingok notifempty }`.

**Checking it ran** (no alerting is configured): `cat /var/backups/ai-import-assistant/last-status.json`;
or a one-liner for a cron/uptime check that fails when the last run is older than 26 h or not ok:
`find /var/backups/ai-import-assistant/last-status.json -mmin -1560 | grep -q . && grep -q '"ok":true' /var/backups/ai-import-assistant/last-status.json`.

**Disk:** each backup ≈ size of the DB dump + size of the storage volume (uploads are
mostly PDFs/images that do not compress, so count the volume at full size). Rule of
thumb: `14 × (dump + volume)` plus 20 % headroom on `/var/backups`. Measure with
`docker system df -v | grep -E 'postgres_data|storage_data'` and `du -sh /var/backups/ai-import-assistant`.
Lower `BACKUP_KEEP_DAILY` if the disk is small.

### Offsite copy (recommended — a backup on the same disk dies with the server)

Set `BACKUP_RCLONE_REMOTE` and `backup.sh` runs `rclone copy` of each new backup
after it is complete. If it is set but `rclone` is missing or the copy fails, the
run is reported as failed (the local backup is still kept). Optional
`BACKUP_RCLONE_KEEP_DAYS=60` deletes offsite copies older than 60 days (default: keep all).
The owner decides where; Google Drive example, as `root` (the cron user) on the server:

```bash
sudo apt-get install -y rclone          # or: curl https://rclone.org/install.sh | sudo bash
sudo rclone config                       # n) New remote → name: gdrive → Storage: drive
#   client_id / client_secret: use your OWN (Google Cloud → APIs → Drive API → OAuth client,
#     "Desktop app"; publish the consent screen to "In production", otherwise Google
#     expires the token after 7 days and the offsite copy silently starts failing)
#   scope: drive.file (or drive) · service account: leave empty
#   "Use web browser to automatically authenticate?" → n (the server has no browser)
#   → on your own PC run:  rclone authorize "drive"   and paste the token back
sudo rclone mkdir gdrive:ai-import-backups
sudo rclone lsd gdrive:                  # must list the folder
```

Then add `BACKUP_RCLONE_REMOTE=gdrive:ai-import-backups` to the cron line (above) and run
`sudo BACKUP_RCLONE_REMOTE=gdrive:ai-import-backups bash scripts/ops/backup.sh` once by hand.
The token lives in `/root/.config/rclone/rclone.conf` — treat it as a secret. Backups hold
user data and password hashes: prefer a Google account used only for this, or add an
rclone `crypt` remote on top (`gdrive-crypt:`) and point `BACKUP_RCLONE_REMOTE` at that.
Any other rclone backend (SFTP to another machine, S3, …) works the same way.

### Restore drill (monthly)

```bash
cd /opt/AI-Import-Assistant
sudo bash scripts/ops/restore-test.sh              # newest backup; or pass a backup directory
```

It restores into a **separate scratch compose project** `aiia-restore` (own volumes,
no published ports, never production), compares row counts with the manifest, checks
the file count and a random sample of 20 files against the archive, prints
`RESTORE DRILL PASS|FAIL in <N>s`, and always removes the scratch project. Write the
date and time of each drill into the table below.

| Date | Backup | Result | Elapsed |
|------|--------|--------|---------|
| 2026-11-11 | `2026-11-11_123512` (db 10.8 MB, storage 1.13 GB, 2026 files; backup took 75 s) | PASS: 6 tables, file count, 20 sampled files | 199 s |

### Recovery targets

- **RPO: 24 h** — one backup per day; at worst you lose everything since 03:15 of the last good day.
- **RTO:** measured 199 s (≈ 3.5 min) for the data restore in the 2026-11-11 drill; add the time to provision a server and rebuild images (`docker compose up -d --build`) in the new-server case below.

### Disaster recovery on a new server

1. Install Docker Engine + Compose v2, `git`, `rclone`; set up Caddy as in "System Caddy block".
2. `sudo mkdir -p /opt && cd /opt && sudo git clone <repo-url> AI-Import-Assistant && cd AI-Import-Assistant`
3. Restore `.env` from your password manager (same `POSTGRES_*`, `JWT_SECRET`, API keys). It must be in place **before** the restore: the new database is created with these credentials.
4. Get the newest backup directory onto the server:
   `sudo mkdir -p /var/backups/ai-import-assistant && sudo rclone copy gdrive:ai-import-backups /var/backups/ai-import-assistant`
   (configure the rclone remote first, see above; backup directories are named `YYYY-MM-DD_HHMMSS`.)
5. Restore into the (empty) production project — this starts only postgres, loads the dump, fills the storage volume and compares row counts:
   `sudo bash scripts/ops/restore.sh --into-production --yes /var/backups/ai-import-assistant/<newest-dir>`
6. Start everything: `docker compose up -d --build` (migrations run on backend boot; a backup from an older schema is upgraded automatically).
7. Verify: `docker compose ps`, `curl -s http://127.0.0.1:8006/health`, log in, open a shipment and a file; optionally `npm run smoke` (see "Smoke test").
8. Re-install the cron job from "Install the daily job".

Restoring over a **live** server (e.g. after bad data) is the same step 5 without the
new-server steps; it stops backend/worker/frontend, **deletes all files in the storage
volume** and overwrites the database objects, so take a fresh `backup.sh` first if the
current state might still matter. `restore.sh` without `--into-production` always goes
to the scratch project and is safe to run any time.

## Alerts

Production failures show up in the app's bell (🔔) as `⚠ Збій: <area> — <title> (<time>)`,
with a distinct «Збій» tag. No outside service is involved.

**What triggers one**
- a backend 5xx response (route pattern + status only, never the request body);
- a chat turn that ends with a server-side failure (user aborts and 429 rate limits do not);
- an ingest job that failed its **last** attempt; a failed reminder / news / tracking / sheet-sync / retry-sweep job;
- `uncaughtException` / `unhandledRejection` in the backend or the worker (the process still exits, as before);
- Anthropic outages: bad key (401/403, key `anthropic-auth`), billing/credits (`anthropic-billing`),
  repeated 429/529 — 3 within 10 min (`anthropic-overloaded`).

The same alert key is delivered at most once per `ALERT_THROTTLE_MINUTES`; the next one carries «(+N схожих)».
Messages never contain secrets, tokens, request bodies, document/chat text or emails.
Every alert is also logged as one JSON line, so the history is:

```bash
cd /opt/AI-Import-Assistant && docker compose logs backend worker | grep ops_alert
```

If the database itself is down, the bell cannot be written; the log line (`delivery_failed`) is the fallback.

**Who gets them:** set `OPS_ADMIN_EMAILS=a@x.com,b@x.com` in `.env` (case-insensitive; empty = every user),
then `docker compose up -d`. The recipient list is cached for 5 minutes. `ops_alert` rows are deleted after 30 days.

**Send a test**

```bash
cd /opt/AI-Import-Assistant && docker compose exec backend node dist/scripts/alert-test.js
# prints: Test ops alert delivered to N recipient(s).   (locally: npm run alert:test)
```

**Readiness:** `GET /health/ready` checks Postgres and Redis (2 s each): 200 or 503. To make it reachable through
Caddy add it to the matcher: `@backend path /api/* /health /health/*`. **A full server outage is not covered**
(nothing is left to write the bell) — a later external uptime monitor can poll `/health/ready`.

## Performance monitoring

- **Postgres must be recreated once** to load the new `command:` (`pg_stat_statements`, `log_min_duration_statement=500`): on `alliance-server` run `cd /opt/AI-Import-Assistant && git pull && docker compose up -d postgres`. Data lives in the `postgres_data` volume and survives. Then restart the backend (`docker compose up -d --build`) — boot runs `CREATE EXTENSION IF NOT EXISTS pg_stat_statements`; if the preload is missing it only warns.
- **Read slow queries:** `cd /opt/AI-Import-Assistant && scripts/ops/slow-queries.sh` prints the top 20 statements by total and by mean time; `scripts/ops/slow-queries.sh --reset` clears the counters. Statements over 500 ms also appear in `docker compose logs postgres`, and the backend logs `[slow-query] <ms>ms <first 200 chars of SQL>` at warn level (threshold: `SLOW_QUERY_MS`, default 500, 0 disables; parameters are never logged).
- **Budgets:** bundle size per route in `frontend/perf-budget.json` (`npm run perf:bundle` after `npm run build`; `node scripts/check-bundle.mjs --update` re-bases it to size + 10 %); Lighthouse thresholds in `frontend/lighthouserc.json` (`npm run perf:lh`). CI runs both in `.github/workflows/perf.yml` and uploads the report as the `lhci-report` artifact. Baselines and numbers: `docs/audits/2026-11-11-performance.md`.

## Environment variables (backend)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ANTHROPIC_API_KEY` | ✅ | — | Claude API (server-side only) |
| `DATABASE_URL` | ✅ | — | PostgreSQL (derived in compose) |
| `REDIS_URL` | — | `redis://localhost:6379` | BullMQ (derived in compose) |
| `JWT_SECRET` | ✅ | — | Session signing (≥16 chars) |
| `ACCESS_CODE` | — | `` (off) | Quick PIN for the UI keypad: 6–8 digits; empty disables it |
| `ACCESS_CODE_EMAIL` | — | — | Account the PIN opens; default = the main (first-created) account |
| `ACCESS_CODE_MAX_FAILURES` | — | `20` | Wrong PINs (all IPs) per 24 h before PIN login locks for 24 h |
| `MCP_DAILY_PER_IP` | — | `3000` | Open `/api/mcp`: requests per IP per UTC day (Redis); over → 429 |
| `MCP_AI_DAILY_CALLS` | — | `300` | Open `/api/mcp`: tool calls per UTC day (all IPs) allowed to spend the Anthropic key; then answers without the AI digest |
| `MCP_AI_DAILY_PER_IP` | — | `60` | Same, per IP |
| `TRUST_PROXY` | — | `loopback,uniquelocal` | Proxies trusted for `X-Forwarded-For` (real client IP for login throttling) |
| `CORS_ORIGIN` | — | `` (empty) | Comma-separated exact origins to allow. Same-origin behind Caddy needs none; set only if the API is served cross-origin |
| `STORAGE_DIR` | — | `./storage` | On-disk file storage root |
| `ANTHROPIC_MODEL` | — | `claude-sonnet-5-5` | Chat agent + structured extraction (backend AND worker) |
| `AGENT_CONTEXT_TOKENS` | — | `1000000` | Chat model context window (shown in the context widget) |
| `AGENT_CLEAR_TRIGGER_TOKENS` | — | `500000` | Above this request size the API clears the oldest tool results (documents read earlier) so reading continues |
| `AGENT_CLEAR_KEEP_TOOL_USES` | — | `8` | Newest tool results always kept word for word |
| `AGENT_EFFORT` | — | `high` | Chat agent reasoning effort (`low`…`max`) |
| `AGENT_MAX_TOKENS` | — | `64000` | Output cap per chat model call (adaptive thinking counts against it) |
| `AGENT_HISTORY_CHAR_BUDGET` | — | `1200000` | Prior turns replayed into a chat (incl. documents read), in chars (~400k tokens) |
| `READ_FILE_MAX_CHARS` | — | `200000` | One `read_file` result before the agent pages on with `range` |
| `MAX_UPLOAD_BYTES` | — | `104857600` | Per-file upload cap (100 MB) |
| `CHAT_RATE_MAX` / `CHAT_RATE_WINDOW` | — | `30` / `1 minute` | Per-user chat rate limit |
| `OCR_ENABLED` | — | `true` | Worker OCR fallback for scanned PDFs / images via Claude vision (`true`/`false`) |
| `OCR_MODEL` | — | `claude-haiku-5-5` | Vision model for OCR / Markdown transcription (spec 007) |
| `EXTRACTION_MODEL` | — | `claude-haiku-5-5` | Structured field extraction in the worker |
| `CLASSIFY_MODEL` | — | `claude-haiku-5-5` | Cheap doc-type classifier |
| `OCR_EFFORT` / `EXTRACTION_EFFORT` | — | `medium` | Reading depth (`low`/`medium`/`high`) |
| `MARKDOWN_VISION_ENABLED` | — | `true` | Transcribe ALL PDFs to Markdown with Claude vision (`false` = vision only for scans; text-layer PDFs use the local parser) |
| `MARKDOWN_PDF_BATCH_PAGES` | — | `5` | PDF pages per Claude vision call |
| `LIBREOFFICE_BIN` | — | `soffice` | LibreOffice binary for legacy `.doc` → `.docx` (installed in the image) |
| `EXTRACTION_ENABLED` | — | `true` | Worker structured field extraction (`true`/`false`) |
| `REMINDERS_ENABLED` | — | `true` | Daily in-app reminder job (`true`/`false`) |
| `REMINDERS_CRON` | — | `0 6 * * *` | Cron for the reminder scan |
| `OPS_ADMIN_EMAILS` | — | `` | Comma-separated emails that get ops alerts in the bell; empty = every user |
| `ALERT_THROTTLE_MINUTES` | — | `15` | The same alert reaches the bell at most once per this many minutes (next one says «+N схожих») |
| `NOVA_POSHTA_API_KEY` (or `NOVAPOSHTA_API_KEY`) | — | `` | Нова Пошта tracking (works keyless; key = richer data) |
| `SEVENTEEN_TRACK_KEY` (or `TRACK17_API_KEY`) | — | `` | 17TRACK parcels / express tracking |
| `TRACKING_SEA_MODE` | — | `manual` | Sea containers kept by hand / from the sheet (`auto` = scrape carrier pages) |
| `SHEET_ID` | — | `` (off) | Team Google Sheet id (shared "anyone with the link can view") → hourly calendar + hub sync |
| `SHEET_SYNC_CRON` | — | `5 * * * *` | Cron for the sheet sync (also runs once on worker boot) |
| `SHEET_FREE_DAYS` | — | `7` | Port free time (days after arrival before demurrage) for sea cargo |
| `SHEET_FREE_DAYS_BY_LINE` | — | `` | Per-line free days, e.g. `MSC:10,MAERSK:7` (a «Free time» sheet column wins) |
| `SHEET_GID_TRACKING` / `_WAREHOUSE` / `_RATES` / `_QUANTITIES` | — | Аркуш3 / Аркуш5 / Черноморск / Аркуш4 gids | Tabs to read (empty = skip) |

## Out of scope for v1 (documented v2 additions)

- ~~**OCR** for scanned images~~ — **now supported** (`OCR_ENABLED`): scanned PDFs
  and images are transcribed with Claude vision in the worker, then indexed and
  field-extracted like any other document.
- **Native structured agent blocks** — reconciliation diff-tables / completeness
  checklists currently arrive as Markdown inside the answer; a typed
  `checks[]`/`diff{}` schema can replace that later without changing the transport.

## Migrating from Voyage/Qdrant (2026-09-30)

Search no longer uses embeddings. After deploying this version, convert files that
were indexed before it (dry-run first):

```bash
docker compose exec worker node dist/db/backfillMarkdown.js          # how many
docker compose exec worker node dist/db/backfillMarkdown.js --apply  # enqueue
```

Until backfilled, `read_file` converts a file lazily on first read. The old
`qdrant` container/volume can then be removed (`docker compose up -d --remove-orphans`,
`docker volume rm <project>_qdrant_data`); `EMBEDDING_*`/`QDRANT_*` in `.env` are ignored.

## Re-reading spreadsheets after a converter change

Spreadsheets read before 2026-11-06 keep the old Markdown layout (converter
`sheet`: no row numbers, the title block as the header). To re-read them with the
current layout (`sheet2`), in the deployed directory:

```bash
docker compose exec backend node dist/ingest/reindexSheets.js          # dry run: what would be re-read
docker compose exec backend node dist/ingest/reindexSheets.js --apply  # queue them for the worker
```

Files whose fields were confirmed by hand on the verification screen are skipped
(a re-read would overwrite the corrections).

## Re-extracting fields after an extraction-schema change

Extractions made before 2026-11-06 lack the document-integrity fields (bank
details, dangerous goods, signature / stamp, blank form fields), so the bank /
dangerous-goods / certificate checks stay silent for those files. To re-run the
field extraction from the already stored Markdown (no repeat OCR; one extraction
call per file), in the deployed directory:

```bash
docker compose exec backend node dist/ingest/reindexExtraction.js                             # dry run: what would be re-extracted
docker compose exec backend node dist/ingest/reindexExtraction.js --apply                     # re-extract every shipment
docker compose exec backend node dist/ingest/reindexExtraction.js --workspace <uuid> --apply  # one shipment only
```

It prints a line per file and the totals, then recomputes every affected shipment
once. Files whose fields were confirmed by hand on the verification screen are
skipped, and a re-extraction that comes back empty keeps the old fields.
