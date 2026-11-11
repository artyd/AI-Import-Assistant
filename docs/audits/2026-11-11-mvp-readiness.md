# MVP readiness — 2026-11-11

Spec: `docs/specs/009-mvp-launch-readiness.md`. Production: https://ai-import-assistant.duckdns.org
(`alliance-server`, `/opt/AI-Import-Assistant`, host Caddy, manual deploys).

## Must

| Line | Status | Proof |
|------|--------|-------|
| Browser + full-flow tests automated | done | `CI` workflow: `e2e` (Playwright on a production build) and `full-stack` (compose stack + mock Anthropic, smoke test with chat, Playwright through Caddy) |
| Production error alerts | done in code; server step left | in-app bell `ops_alert` (5xx, chat, final ingest failures, jobs, crashes, Anthropic outages), unit tests; on the server: set `OPS_ADMIN_EMAILS`, run `alert-test.js` |
| Privacy and terms pages | done in code; **operator details missing** | `/privacy`, `/terms`, Playwright `legal-pages.spec.ts`; placeholders in `frontend/lib/legal/operator.ts` must be filled by the owner |
| Live server setup | done | see "Live checks" |
| Backup and tested restore | done in CI; server drill left | `Backup & restore` workflow (backup → wipe → restore → verify) green; on the server: cron, rclone remote, first `restore-test.sh` |
| Public tool endpoint rate limit | done | `src/mcp/limits.ts`: per-IP 120/min + 3000/day (fail open), AI budget 300/day total, 60/day per IP (fail closed), body/batch limits; unit tests; ADR-0008 |
| Staging launch rehearsal | CI part done; prod part after deploy | see "Rehearsal" |

## Should

| Line | Status | Proof |
|------|--------|-------|
| Page and database speed measured | pages done; DB collects after deploy | `docs/audits/2026-11-11-performance.md`; `Perf` workflow; `pg_stat_statements` + `[slow-query]` log + `scripts/ops/slow-queries.sh` |

## Live checks (2026-11-11)

- DNS + HTTPS: Let's Encrypt cert valid to 2027-01-04; http → https 308.
- `/`, `/login`, `/supply`, `/health`: 200. `/api/mcp` answers.
- HSTS was missing; added in `frontend/next.config.mjs` (`max-age=31536000`), live after the next deploy.
- Live Anthropic key and first user: production chat and login work (owner's account).
- Deploy mode: **manual by decision** (`DEPLOY_ENABLED` stays off).

## Defects found during the work

- Smoke test expected 7 folders; the skeleton has 6. Fixed.
- The «Карта» view crashed when `/api/hub/live` answered without `vessels`
  (`HubCanvas.tsx` read `snap.vessels.length`). Fixed with a guard spec
  (`frontend/e2e/hub-map-no-crash.spec.ts`).

## Rehearsal

| Step | CI stack | Production |
|------|----------|------------|
| Login | pass (full-stack Playwright) | after deploy |
| Upload + reading | pass (smoke test, mock Anthropic) | after deploy |
| Chat | pass (smoke test, chat on) | after deploy |
| Export | pass (smoke test) | after deploy |
| Recovery | pass (`Backup & restore` workflow) | first `restore-test.sh` on the server |

## Left before launch

1. Deploy: `cd /opt/AI-Import-Assistant && git pull && docker compose up -d --build`, then `docker compose up -d postgres` once (pg_stat_statements).
2. Caddy matcher: `@backend path /api/* /health /health/*`.
3. `OPS_ADMIN_EMAILS` in `.env`, then `docker compose exec backend node dist/scripts/alert-test.js`; check the bell.
4. Backup cron (03:15) + rclone remote + `BACKUP_RCLONE_REMOTE`; run `sudo bash scripts/ops/restore-test.sh` and write the result into DEPLOYMENT.md.
5. Owner sends the operator details for the legal pages.
6. Production rehearsal on a test shipment: login, upload, reading, chat, export.
