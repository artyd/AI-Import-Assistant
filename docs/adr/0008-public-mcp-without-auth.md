# The public MCP endpoint has no auth

`/api/mcp` is an open, stateless MCP endpoint with a 120 req/min per-IP rate limit. claude.ai treats any 401 as "start OAuth" and fails to register, so the token-in-URL version was dropped (PR #50). It exposes only reference tools, sheet tools and hub tools, never shipment documents. The user explicitly accepted that anyone with the URL can list sheet shipments.

## Consequences

Every anonymous call to `uktzed_lookup_code` spends the server's Anthropic key. `/api/mcp` has its own CORS rule (`*`, no credentials).

## Abuse and cost limits (2026-11)

The endpoint stays open (no auth, no 401), but it now has durable limits so abuse cannot run up the Anthropic bill or overload the service. Counters live in Redis (`src/mcp/limits.ts`, behind the small `McpCounters` interface; `INCR` + `EXPIREAT` in one Lua script) on a dedicated fail-fast client, per UTC day. We count them ourselves instead of through `@fastify/rate-limit`'s `redis` option, because that option is plugin-wide and would also move the login and chat limiters.

**Anthropic-spending MCP paths.** Only one: `uktzed_lookup_code` → `runUktzedLookup` → `digestUktzedSections` (`customs/logist/uktzedDigest.ts`), which digests large qdpro sections with `LOGIST_DIGEST_MODEL`. Every other exposed tool (classifier, dual-use, NBU, PubChem, drug registry, tracking, port status, sheet, where-are-shipments) calls no model. `suggest_routes` also calls Anthropic but is chat-only.

| Limit | Value | When over |
|-------|-------|-----------|
| Per-IP burst | 120 / minute | 429 + `Retry-After` |
| Per-IP daily | `MCP_DAILY_PER_IP` (3000) | 429 + `Retry-After` (to 00:00 UTC) |
| AI calls, all IPs | `MCP_AI_DAILY_CALLS` (300) | tool answers without the AI digest |
| AI calls, per IP | `MCP_AI_DAILY_PER_IP` (60) | same |
| Body | 256 KB (route `bodyLimit`) | 413 |
| JSON-RPC batch | 20 calls | 400 |
| Tool argument | zod: strings ≤ 200 chars, ≤ 20 fields | JSON-RPC `-32602` |
| Tool call time | 30 s | JSON-RPC `-32001` |

**AI budget.** One unit is charged per tool call, only when the digest would really call the model (a cache hit or a small section costs nothing). Per-IP is checked before global, so one noisy IP cannot drain the shared budget. A spent budget degrades to the raw qdpro text (large sections truncated), prefixed by a Ukrainian note that the AI summary is unavailable today; that raw answer is never cached.

**Redis down.** Request limits fail OPEN (keep serving, one warning per minute). The AI budget fails CLOSED (no AI digest), so an outage cannot open the wallet.

**Per-IP limits stay generous** because claude.ai users share Anthropic's egress IPs; the global AI budget is the real cost guard.

**Observability.** `onMcpLimitEvent` writes one warn-level log line when an IP hits its daily request cap or AI cap, and when the global AI budget crosses 80 % and 100 % — each once per UTC day (the counter value is the once-guard). There is no external alerting.
