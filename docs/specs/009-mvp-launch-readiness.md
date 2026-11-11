# 009 — MVP launch readiness

Status: in work (2026-11-11)

The product is built and already runs in production at
https://ai-import-assistant.duckdns.org (host `alliance-server`,
`/opt/AI-Import-Assistant`, host Caddy, manual deploys). What blocks a safe MVP
is the release around it: tests that still run by hand, nothing that tells the
team when production breaks, no legal pages, no tested restore, and an open
endpoint without a cost ceiling.

## Goal

MVP is reached when every **Must** line below is done and proven, and the
staging rehearsal passes end to end.

## Work packages

| # | Package | Owner | Proof |
|---|---------|-------|-------|
| 1 | Browser tests + full-flow smoke in CI: Playwright on a production build; the whole compose stack with a mock Anthropic, smoke test with chat, Playwright against the stack | Agent `e2e-ci` | green `CI` run on GitHub |
| 2 | Production error alerts in the in-app bell for admins (`OPS_ADMIN_EMAILS`, everyone if empty): `src/lib/alerts.ts` (throttled, scrubbed) on 5xx, chat failures, final ingest failures, job failures, crashes, Anthropic outage errors; `GET /health/ready` | Agent `alerts` | unit tests; `npm run alert:test` on the server shows an alert in the bell |
| 3 | Privacy and terms pages `/privacy`, `/terms` (Ukrainian), linked from login, entry, `/supply` and the app nav; operator details in `frontend/lib/legal/operator.ts` | Agent `legal-pages` | Playwright spec; operator placeholders filled |
| 4 | Backup + tested restore: `scripts/ops/backup.sh` (pg_dump + storage volume + manifest, rotation 14 days, optional rclone offsite), `restore.sh` (scratch project by default), `restore-test.sh` drill | Agent `backup-restore` | `backup-restore` workflow green; first drill on the server PASS with measured RTO |
| 5 | Public MCP endpoint limits: Redis-backed per-IP burst + daily caps, global and per-IP daily AI budget that degrades to non-AI answers, body/batch/argument/timeout limits | Agent `mcp-guard` | unit tests; ADR-0008 updated |
| 6 | Speed measurements (Should): bundle budget, Lighthouse CI, production Lighthouse numbers, `pg_stat_statements` + slow-query log + `slow-queries.sh` | Agent `perf` | `perf` workflow green; `docs/audits/2026-11-11-performance.md` |
| 7 | Live server setup confirmed: domain + HTTPS, live keys, first user, deploy mode | Orchestrator | checks recorded in the readiness audit |
| 8 | Staging launch rehearsal: login, upload, reading, chat, export, recovery on a production-like stack | Orchestrator | rehearsal log in the readiness audit |

## Decisions

- `/api/mcp` stays open (ADR-0008); abuse and cost are bounded by limits, not login.
- Alerts go only to the in-app bell (owner, 2026-11-11: no Telegram, no outside service). A full server outage is not covered; an uptime monitor can poll `/health/ready` later.
- Backups: 14 days on the server plus an rclone offsite copy; a failed backup exits non-zero and writes `last-status.json`.
- MCP AI budget: 300 calls/day in total (owner, 2026-11-11).
- Operator details on the legal pages stay placeholders until the owner sends them; launch needs them filled.
- Backups never restore into production unless `--into-production --yes` is given.
- Slow-query logging never logs query parameters (they can hold personal data).
- Deploys stay manual (`DEPLOY_ENABLED` off) unless the owner decides otherwise.

## After MVP

Consolidated-load chat tools, native structured answer blocks, live vessel
tracking upgrades, user-provided AI keys beyond analysis.
