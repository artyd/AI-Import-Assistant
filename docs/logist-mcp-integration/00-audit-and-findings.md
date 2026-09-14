# logist_mcp → Штурман — Audit & Integration Findings

Status: **read-only audit only. No code changed.** This is a findings document +
phased plan, per the "audit → findings → one action prompt per phase" workflow.

Scope reminder: the deployment target (`alliance-server`, host-managed Caddy,
shared with `aglex.` / `spai.` / `gitway.alliancegroup95.com`) must not be
disrupted. There is no local dev env; the safe stopping point for any phase is
**typecheck + build green**, not a live prod test.

The two Python deliverables under audit live outside the repo (provided as a zip):
`logist_mcp.py` (496 lines — FastMCP server, 6 read-only tools, Streamable HTTP)
and `drlz_build_cache.py` (136 lines — standalone drlz.info crawler → local JSON).

---

## Part 1 — Findings (one per audit point)

### 1. How the agent currently calls tools (the pattern to mirror)

Fully manual, all in TypeScript. End-to-end for `sort_inbox` (representative):

- **Schema:** `src/agent/tools.ts` exports `toolDefinitions` — a plain array of
  Anthropic tool objects `{ name, description, input_schema }`. `sort_inbox` is
  `{ name: 'sort_inbox', description, input_schema: { type: 'object', properties: {} } }`.
- **Registration with the API call:** `src/agent/loop.ts` passes `tools` (default
  `toolDefinitions`) straight into `anthropic.messages.stream({ model, system,
  messages, tools, thinking })`. No `mcp_servers`, no beta headers.
- **Dispatch:** the loop reads `msg.content` for `tool_use` blocks and calls
  `executeTool(block.name, block.input, ctx)` (`src/agent/tools.ts`), a `switch`
  over the tool name (`case 'sort_inbox': …`). Each handler returns
  `{ result: string, summary: string, citations: Citation[] }`.
- **Back into the conversation:** the loop pushes a `tool_result` block
  (`tool_use_id` + `result` string) into `messages` and re-invokes the model
  (loop, `MAX_ITERATIONS = 8`) until `stop_reason !== 'tool_use'`.
- **Back to the UI:** the loop emits SSE `tool_call` (name + input) and
  `tool_result` (summary) events; the frontend renders these as **AgentLog**
  chips. The model's final text streams as `token` events and renders as
  Markdown. `ToolContext` carries `{ workspaceId?, collectionId?, ownerId? }`.

**Any new tool mirrors exactly this:** add an entry to `toolDefinitions`, add a
`case` to `executeTool` returning `{ result, summary, citations }`.

### 2. Native MCP connector vs manual wrappers — what the code actually does

**No native MCP connector anywhere.** Grepping `src/**.ts` for `mcp_servers`,
`modelcontextprotocol`, `anthropic-beta`, `mcp_client` → zero hits. The agent uses
manually-defined TS tool schemas + a manual dispatch switch (point 1). The
`@anthropic-ai/sdk` is called via `messages.stream` with a plain `tools` array.

Consequence: wiring `logist_mcp` in is **not** "point the Messages API at one more
URL." It is "add N tool definitions + N dispatch cases in TS, each of which talks
to the Python server." See the recommendation in Part 3.

### 3. Docker Compose structure

`docker-compose.yml` services: `postgres` (16-alpine), `redis` (7-alpine),
`qdrant` (latest), `backend` (build; host bind `127.0.0.1:8006:8080`), `worker`
(build; **no host port** — internal only), `frontend` (build; `127.0.0.1:8007:3000`).
Named volumes: `postgres_data`, `redis_data`, `qdrant_data`, `storage_data`.

- **No custom network is declared** → all services share the Compose **default
  network** and reach each other by **service name** (`postgres`, `redis`,
  `qdrant`). The backend already talks to these internally.
- backend/frontend bind only to `127.0.0.1` on the host; public traffic arrives
  via the host's system Caddy. `worker` has no host port at all — the model for
  an internal-only service already exists.
- **No `caddy` service in Compose** (the app is fronted by the host's Caddy).

**Implication:** a new `logist-mcp` service can join the default network and be
reachable by the backend at `http://logist-mcp:<port>` with **no host port and no
Caddy route** — i.e. **zero surface on the shared server**. A DRLZ cache file
needs one new named volume (e.g. `drlz_cache`) mounted into both `logist-mcp`
(read) and the refresher (write); no port, no volume-name collision with the four
existing volumes.

### 4. Caddy configuration

**No Caddyfile in the repo** (`find -iname '*caddy*'` → nothing; no `caddy`
Compose service). Routing for `ai-import-assistant.duckdns.org` is managed
host-side, outside version control, alongside the three other production sites.

**Therefore: keep logist-mcp off Caddy entirely.** If we adopt the internal-only
wiring (Part 3), **no host Caddy change is required at all** → the shared-server
risk area is not touched. Any design that instead needs a public URL for
logist-mcp (e.g. Anthropic's native connector) would force a host Caddy edit,
which is exactly the risk we should avoid. This is a strong point in favor of the
manual-wrapper approach.

### 5. Scheduled/background job patterns (for the DRLZ cache refresh)

BullMQ repeatable-cron is already the established pattern, used twice:
- `src/queue/reminders.ts`: `remindersQueue.add(name, data, { repeat: { pattern:
  config.REMINDERS_CRON }, removeOnComplete: true, removeOnFail: 50 })`,
  scheduled from `src/worker/index.ts` via `scheduleReminders()` (gated by
  `REMINDERS_ENABLED`).
- `src/queue/news.ts`: identical shape with `config.NEWS_CRON` / `scheduleNews()`
  (gated by `NEWS_ENABLED`) — this is the pattern I added in Phase C.

**The DRLZ refresh fits this exactly** — a repeatable BullMQ job (e.g. weekly
`DRLZ_CRON`, gated by `DRLZ_ENABLED`) rather than host cron (which would be a
second, inconsistent scheduler on the shared box). Two viable executors:
- **(a) Shell out to Python** from the TS worker (`child_process` running
  `drlz_build_cache.py` inside the logist-mcp image / a sidecar). Keeps the crawler
  as-is but couples the TS worker to a Python runtime.
- **(b) Re-port the crawler to TS** as a normal BullMQ job (fetch + cheerio parse
  → write JSON, or better, upsert into Postgres — see point 7).

Recommendation: **(b), re-ported to TS, writing into the existing `drug_registry`
Postgres table** — see point 7 and the risk flags. It removes the Python runtime
from the scheduling path, reuses the exact reminders/news job shape, and unifies
the two drug-registry mechanisms instead of running two. (If we want minimal churn
first, (a) is an acceptable interim.)

### 6. Environment variable / config conventions

`src/config.ts` is a single **zod-validated** env schema (fails fast on boot);
`.env.example` documents every var; services read `config.X`. New vars follow
this: `LOGIST_MCP_URL` (e.g. `http://logist-mcp:8000`), and for the DRLZ refresh
`DRLZ_ENABLED` (bool, default false), `DRLZ_CRON` (default weekly), and — if we
keep a JSON cache rather than Postgres — `DRLZ_CACHE_PATH`. All map cleanly onto
the existing `NEWS_ENABLED`/`NEWS_CRON`/`AIS_*` precedent. **No secrets are needed**
— every upstream (qdpro, NBU, PubChem, drlz.info) is public/unauthenticated, which
notably simplifies the security story vs. a typical external integration.

### 7. Existing UKTZED / drug-registry scaffolding (do not duplicate)

Two real overlaps already in the tree — this is the most important finding:

- **Drug register (direct overlap with `drlz_*`).** There is already a
  `drug_registry` Postgres table + `src/services/drugRegistry.ts` + the
  `check_drug_registration` agent tool + `scripts/ingest-drug-registry.mjs`. It is
  a **local mirror of the Ukrainian medicinal-products register**, queried
  deterministically by registration number. `logist_mcp`'s
  `drlz_lookup_registration` + `drlz_build_cache.py` are a **second, parallel
  implementation of the same idea** (crawl the register → local snapshot →
  offline lookup), differing in source site (drlz.info vs drlz.com.ua) and lookup
  style (substring vs reg-number). **These should be reconciled, not run side by
  side:** point the new crawler at `drug_registry` (add the columns it needs) and
  extend `drugRegistry.ts` with a substring search, exposed either by widening
  `check_drug_registration` or adding one sibling tool. Two mirrors of the same
  register on the same box is exactly the "fragile one-off" outcome to avoid.

- **UKTZED / customs data (complementary, not duplicate).** The Phase-B analysis
  engine already ships local reference data — `uktzed_code_db.json`,
  `hs_duty_table.json`, `ua_mfn.json`, `ua_mfn_ranged.json`, plus the
  resolve/hsmatch/mfn engines. That is a **static snapshot for bulk
  calculation**. `logist_mcp`'s `uktzed_lookup_code` scrapes qdpro.com.ua **live**
  for authoritative per-code detail the static data doesn't hold (licensing,
  trade-agreement preferences, narcotic/precursor restrictions, tech-regs). These
  are complementary: keep the static engine for the consolidated-cargo math; use
  the live tool for a single-code authoritative check. Worth a note in the system
  prompt so the model knows which to reach for.

### 8. Chat / UI rendering of tool results

Tool outputs are **plain text fed back to the model**, which folds them into its
Markdown answer; the *fact* of each call shows as an **AgentLog** `tool_call` /
`tool_result` chip (summary only). There is no per-tool structured card except the
bespoke consolidated **AnalysisCard**. So `logist_mcp`'s plain-text returns render
consistently **with no UI work** — they flow into the agent's answer and appear as
tool chips. A structured card (e.g. a UKTZED duty-rate table) would be a *later,
optional* UI phase, not a prerequisite.

---

## Part 2 — Phased integration plan

Each phase is small enough to become its own action prompt. Verification for every
phase is **typecheck + build green** (no live prod test env); phases touching the
shared server call it out explicitly.

**Phase 0 — Smoke-test the risky Python tools (no repo change).** Before trusting
anything, run `logist_mcp.py` locally (stdio + MCP Inspector) and exercise all 6
tools against their *real* upstreams; run `drlz_build_cache.py --pages 5` and
eyeball the parse. Rationale: the author flags `dualuse_browse_classifier`,
`pubchem_identify_substance`, and the drlz parser as **never live-tested**. Files:
none in this repo. Shared-server risk: **none** (runs off-box). Verify: each tool
returns sane data; the crawler parses >0 records on real HTML.

**Phase 1 — Add the `logist-mcp` service to Compose (internal-only).** New
`logist-mcp` service (build from the Python file + deps), **no host port**, joined
to the default network, reachable at `http://logist-mcp:8000`. Add `LOGIST_MCP_URL`
to `config.ts` + `.env.example`. Files: `docker-compose.yml`, `src/config.ts`,
`.env.example`, a new `Dockerfile.logist` (+ `requirements.txt`). Shared-server
risk: **none** (no host port, no Caddy, no volume-name clash). Verify: `docker
compose config` valid; backend typecheck/build green (config parses).

**Phase 2 — Wrap the 4 network-live tools as TS agent tools.** Add
`uktzed_lookup_code`, `uktzed_browse_classifier`, `dualuse_browse_classifier`,
`get_exchange_rate`, `pubchem_identify_substance` to `toolDefinitions` + a
`case` each in `executeTool`, each calling `logist-mcp` internally (transport per
Part 3), returning `{ result, summary, citations: [] }`. Wire these into the
appropriate chat kind(s) (supply + consolidated; likely not `normal`). Add a
system-prompt note (static engine vs live lookup, and the advisory-only UKTZED
rule already in the grounding contract). Files: `src/agent/tools.ts`,
`src/agent/systemPrompt.ts`, maybe a small `src/services/logist/*` client. Shared
risk: **none**. Verify: typecheck/build; a scripted local tool-dispatch unit test
if practical.

**Phase 3 — Reconcile the drug register (the `drlz_*` overlap).** Decide + build:
extend `drug_registry` (columns for name/substance/holder substring search),
re-port `drlz_build_cache.py` as a TS crawler upserting into it, and add substring
search to `drugRegistry.ts` exposed via the agent. Do **not** ship logist's
separate JSON cache + `drlz_lookup_registration` as a parallel mirror. Files:
`src/db/schema.sql` (idempotent columns/index), `src/services/drugRegistry.ts`, a
new `src/queue/drlz.ts` + worker wiring, `src/agent/tools.ts`. Shared risk: **none**
(DB is this project's own Postgres). Verify: typecheck/build; migration idempotent.

**Phase 4 — Schedule the DRLZ refresh as a BullMQ repeatable job.** Mirror
`news.ts`/`reminders.ts`: `DRLZ_ENABLED` + `DRLZ_CRON` (weekly), `scheduleDrlz()`
in the worker, gated off by default. Files: `src/queue/drlz.ts`,
`src/worker/index.ts`, `src/config.ts`, `.env.example`. Shared risk: **none** (uses
the existing Redis/worker; off by default). Verify: typecheck/build; job schedules
only when enabled.

**Phase 5 (optional, later) — structured UI cards.** If desired, render a UKTZED
duty-rate/restrictions card instead of inline text (like AnalysisCard). Files:
frontend only. Shared risk: none. Verify: frontend tsc/build.

---

## Part 3 — Recommendation: manual wrapper, not the native connector

**Use manual TS tool wrappers. Do not use Anthropic's native `mcp_servers`
connector.** Reasons tied to what's in the repo:

1. **The native connector requires a publicly reachable MCP URL** (Anthropic's
   servers connect inbound). That forces exposing `logist-mcp` through the host's
   system Caddy — the one change we're told to avoid on the shared server (point
   4). The manual wrapper keeps `logist-mcp` internal-only (point 3) → **zero
   shared-server surface**.
2. **The entire tool UX depends on the manual dispatch loop** (points 1, 8): SSE
   `tool_call`/`tool_result` events, the AgentLog chips, the grounding contract's
   per-tool control, `ToolContext` scoping, and `MAX_ITERATIONS`. Native-connector
   tool calls resolve at Anthropic's side and would bypass this machinery.
3. **There is no MCP-connector code to build on** (point 2) — adopting it is a new,
   beta call path, whereas adding tools to `toolDefinitions` + `executeTool` is the
   codebase's own, proven pattern.

**Transport sub-decision (how the TS handler reaches the Python server), internal
either way:** `logist_mcp` speaks MCP Streamable HTTP, not plain REST. Two options:
- **(a)** TS handlers use the official MCP TS client (`@modelcontextprotocol/sdk`)
  against `http://logist-mcp:8000/mcp` — protocol-faithful, Python unchanged, but
  adds a dependency + an initialize handshake per call.
- **(b)** Add a thin plain-HTTP/JSON surface to the Python service (the 6 tools are
  stateless read-only functions) and have TS `fetch` it — no new TS dep, simplest
  dispatch, at the cost of a small Python addition.

Recommend **(b)** for the first cut (lowest complexity/deps, and these tools are
trivially stateless); **(a)** is the cleaner long-term answer if we later add
stateful or many more MCP servers. Either keeps the server internal.

---

## Part 4 — Risk flags in the Python design (seen against prod constraints)

1. **Untested scrapers / parsers (highest risk).** The author explicitly notes
   `dualuse_browse_classifier`, `pubchem_identify_substance`, and
   `drlz_build_cache._parse_page` were written **without a live network test**
   against the real targets. `drlz_build_cache` even warns "0 records recognized —
   selectors probably differ." → **Phase 0 smoke test is mandatory** before these
   are trusted; add a non-empty-count guard so a silently-empty crawl never
   overwrites a good cache/table.
2. **Scrape fragility.** `uktzed_lookup_code` / `_browse_classifier` /
   `dualuse` depend on qdpro.com.ua's Drupal HTML and a text marker
   (`"Головне меню"`). A site redesign breaks them with no schema contract. Accept
   as inherent, but wrap results so a parse miss returns a clear "source layout
   changed" message rather than garbage.
3. **No retry/backoff; 20s timeout inside a live chat turn.** A slow qdpro page (or
   several tool calls in one turn) can stall the SSE stream for tens of seconds.
   Recommend a shorter per-call budget + one bounded retry, and surfacing timeouts
   as a normal tool_result (the loop already degrades a thrown tool to an error
   string, so this is about latency UX, not crashes).
4. **`dualuse_browse_classifier` uses opaque internal `node_id`s** that must be
   scraped out of a previous response to descend — brittle for the model to
   navigate reliably. Flag for evaluation; may need the wrapper to surface the
   child node_ids explicitly, or a usage note in the tool description.
5. **Duplicate drug register** (point 7): shipping `drlz_lookup_registration` +
   its JSON cache alongside the existing `drug_registry`/`check_drug_registration`
   would put two mirrors of the same register on the box. Reconcile (Phase 3).
6. **Minor:** `drlz_build_cache` uses blocking `time.sleep` inside async (harmless
   for a single-threaded crawl, but if re-ported to TS use the async delay);
   PubChem's 5 req/s policy is fine for single calls but don't loop the tool
   without a delay; `DRLZ_CACHE_PATH` defaults to a relative path (`drlz_cache.json`)
   — pin it to a mounted volume path via `config` if we keep the JSON approach.

---

## One-line bottom line

Manual TS wrappers over an **internal-only** `logist-mcp` service (no Caddy, no host
port, no secrets), reusing the existing `toolDefinitions`/`executeTool`, BullMQ
repeatable-job, and `config.ts` patterns; **reconcile the DRLZ tool with the
existing `drug_registry` mirror** instead of duplicating; and **smoke-test the
three never-live-tested scrapers first**. No shared-server change required.
