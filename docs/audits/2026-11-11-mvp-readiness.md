# MVP readiness — 2026-11-11

Spec: `docs/specs/009-mvp-launch-readiness.md`. Production: https://ai-import-assistant.duckdns.org
(`alliance-server`, `/opt/AI-Import-Assistant`, host Caddy, manual deploys).

## Must

| Line | Status | Proof |
|------|--------|-------|
| Browser + full-flow tests automated | done | `CI` workflow: `e2e` (Playwright on a production build) and `full-stack` (compose stack + mock Anthropic, smoke test with chat, Playwright through Caddy) |
| Production error alerts | done | in-app bell `ops_alert` (5xx, chat, final ingest failures, jobs, crashes, Anthropic outages), unit tests; on the server `alert-test.js` → "delivered to 3 recipient(s)" (`OPS_ADMIN_EMAILS` left empty = every user; login is by PIN) |
| Privacy and terms pages | done in code; **operator details missing** | `/privacy`, `/terms`, Playwright `legal-pages.spec.ts`; placeholders in `frontend/lib/legal/operator.ts` must be filled by the owner |
| Live server setup | done | see "Live checks" |
| Backup and tested restore | done | `Backup & restore` workflow green; server drill 2026-11-11 **PASS in 199 s** (6 tables, 2026 files, 20 sampled files). Offsite rclone copy and the daily cron are not set up yet (`offsite=no`) |
| Public tool endpoint rate limit | done | `src/mcp/limits.ts`: per-IP 120/min + 3000/day (fail open), AI budget 300/day total, 60/day per IP (fail closed), body/batch limits; unit tests; ADR-0008 |
| Staging launch rehearsal | done | see "Rehearsal" |

## Should

| Line | Status | Proof |
|------|--------|-------|
| Page and database speed measured | pages done; DB collects after deploy | `docs/audits/2026-11-11-performance.md`; `Perf` workflow; `pg_stat_statements` + `[slow-query]` log + `scripts/ops/slow-queries.sh` |

## Live checks (2026-11-11)

- DNS + HTTPS: Let's Encrypt cert valid to 2027-01-04; http → https 308.
- `/`, `/login`, `/supply`, `/health`: 200. `/api/mcp` answers.
- HSTS was missing; added in `frontend/next.config.mjs` (`max-age=31536000`); live after the deploy.
- After the deploy: `/privacy`, `/terms` 200 (operator placeholders still shown); `/health/ready` is not routed through Caddy (404 outside). The owner kept the Caddy matcher as is: no external uptime monitor uses it.
- Live Anthropic key and first user: production chat and login work (owner's account).
- Deploy mode: **manual by decision** (`DEPLOY_ENABLED` stays off).

## Defects found during the work

- Smoke test expected 7 folders; the skeleton has 6. Fixed.
- The first server restore drill reported FAIL although the data was intact: the drill hashed hard-link entries of `_tree/` as empty, and its row-count loop compared only `users` (stdin swallowed by `docker compose exec`). Fixed in 89a7249; the rerun passed.
- The «Карта» view crashed when `/api/hub/live` answered without `vessels`
  (`HubCanvas.tsx` read `snap.vessels.length`). Fixed with a guard spec
  (`frontend/e2e/hub-map-no-crash.spec.ts`).

## Rehearsal

| Step | CI stack | Production |
|------|----------|------------|
| Login | pass (full-stack Playwright) | pass (PIN session) |
| Upload + reading | pass (smoke test, mock Anthropic) | pass: test shipment №2026-3310, `MVP_test_invoice.csv` read 1/1, fields extracted, auto-filed into «Контракт, інвойс, пакувальний» |
| Chat | pass (smoke test, chat on) | pass: amount 2 100 USD CIF Odesa, net 500 kg, gross 540 kg, with a source link |
| Export | pass (smoke test) | pass: `GET /api/workspaces/:id/export` 200 `application/zip`, the file + `_Generated/` (discrepancy report, checklist, `shipment_report.html`) |
| Recovery | pass (`Backup & restore` workflow) | pass: `restore-test.sh` PASS in 199 s |

## Left before launch

1. Owner sends the operator details for the legal pages (`frontend/lib/legal/operator.ts`). This is the only Must item still open.

Recommended soon after launch: the daily backup cron (03:15) and the offsite rclone copy (`BACKUP_RCLONE_REMOTE`): today the only backup sits on the server's own disk. Optional: `docker compose up -d postgres` once so `pg_stat_statements` loads.
