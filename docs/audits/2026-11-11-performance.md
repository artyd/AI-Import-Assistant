# Performance baseline — 2026-11-11

Scope: measurement and monitoring only. Nothing was optimised. Method: Next 15.5.26 production build, Lighthouse via `@lhci/cli@0.16.0`, desktop preset, 3 runs, median; Chrome 155 headless, Windows Server 2022 dev machine (local) and the live site (production).

## 1. Bundle size (first-load JS, gzip)

Measured by `frontend/scripts/check-bundle.mjs` from `.next/app-build-manifest.json` (page entry + every layout above it, `.js` only, gzipped). Matches the `next build` "First Load JS" column within ~1 KB. Budget = measured + 10 %, rounded up (`frontend/perf-budget.json`). Shared by all routes: 103 KB.

| Route | First-load JS | Budget |
|---|---:|---:|
| `/` (entry) | 113.2 KB | 125 KB |
| `/login` | 109.6 KB | 121 KB |
| `/supply` | 124.3 KB | 137 KB |
| `/workspaces` | 110.7 KB | 122 KB |
| `/workspaces/[id]` | 227.4 KB | 251 KB |
| `/workspaces/[id]/instruction` | 165.7 KB | 183 KB |

`npm run build && npm run perf:bundle` passes.

## 2. Lighthouse — local (`next start`, 127.0.0.1:3100)

Medians of 3 runs.

| Page | Perf | A11y | Best-pr. | LCP | CLS | TBT |
|---|---:|---:|---:|---:|---:|---:|
| `/login` | 1.00 | 0.87 | 0.96 | 404 ms | 0 | 0 ms |
| `/` | 1.00 | 1.00 | 0.96 | 564 ms | 0.003 | 23 ms |

Assertions in `frontend/lighthouserc.json` (all `error`): performance ≥ 0.95, best-practices ≥ 0.91, accessibility ≥ 0.82 (`/login`) / ≥ 0.95 (`/`) — i.e. baseline − 0.05 (rounded down for `/login` a11y); LCP ≤ 1500 ms (`/login`) / 1700 ms (`/`), CLS ≤ 0.05, TBT ≤ 200 ms (about 3× headroom over the baseline so CI-runner noise does not flake). `npm run perf:lh` passes.

Local best-practices 0.96 vs 1.00 in production is plain HTTP (no HTTPS) locally.

## 3. Lighthouse — production (https://ai-import-assistant.duckdns.org)

Measured once on 2026-11-11, desktop, 3 runs, median.

| Page | Perf | A11y | Best-pr. | LCP | CLS | TBT |
|---|---:|---:|---:|---:|---:|---:|
| `/login` | 1.00 | 0.93 | 1.00 | 460 ms | 0 | 0 ms |
| `/` (entry) | 1.00 | 1.00 | 1.00 | 451 ms | 0.003 | 0 ms |

Only the public pages can be measured; logged-in pages (`/workspaces/*`, the heaviest bundles) are not covered by Lighthouse here.

## 4. Database

Not measured — this machine has no Docker/Postgres, so there are no query timings yet. What is in place so the numbers collect themselves after the next deploy:

- `docker-compose.yml`: postgres `command:` loads `pg_stat_statements` (`track=all`) and logs statements > 500 ms (`log_min_duration_statement=500`). Image, env and volume unchanged. Needs `docker compose up -d postgres` once.
- `src/db/migrate.ts`: `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` runs on every boot (outside the schema-hash skip, since postgres may be recreated after the schema was last applied); failure only warns.
- `src/db/pool.ts` + `src/db/slowQuery.ts`: every pooled client's `query` is timed; queries ≥ `SLOW_QUERY_MS` (default 500, 0 disables) log `[slow-query] <ms>ms <first 200 chars of SQL>` at warn level. Parameters are never read or logged. Covers `query()`, `pool.query()` and explicit `pool.connect()` transactions; the pool API is unchanged. Unit-tested in `src/db/__tests__/slowQuery.spec.ts`.
- `scripts/ops/slow-queries.sh`: top 20 by total and by mean time; `--reset`.

Untested here: the compose `command:` and the extension creation have not run against a real Postgres.

## 5. Suggested improvements (not implemented)

1. **Lazy-load heavy libraries on `/workspaces/[id]` (227 KB, 2× any other route).** The route adds a 42 KB shared chunk and a 73 KB page chunk over the login baseline. Likely contributors are `react-markdown`/`remark-gfm` and Leaflet, which only some views need — `next/dynamic` them. Which libraries are in the 42 KB chunk is not yet verified (run a bundle analyzer first). Expected: −40 to −60 KB gzip on that route (≈ 20–25 %).
2. **Fix `/login` accessibility.** Lighthouse flags `color-contrast` and `landmark-one-main` (no `<main>`); fixing both should take a11y from 0.87 to about 1.0, and it is a few-line change. (`is-crawlable` also fails, pulling SEO to 0.63 — probably intentional for a private app, leave it.)
3. **Trim the 103 KB shared bundle.** Every route, including the 110 KB login page, pays for it; check whether icon/state libraries are imported through barrels in the root layout and what can be deferred. Expected: 10–20 KB off every route. Speculative until analysed.

After the deploy, let `pg_stat_statements` run for about a week and review `scripts/ops/slow-queries.sh` output before touching any index — there is no data yet to size that gain.
