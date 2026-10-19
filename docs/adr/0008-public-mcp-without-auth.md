# The public MCP endpoint has no auth

`/api/mcp` is an open, stateless MCP endpoint with a 120 req/min per-IP rate limit. claude.ai treats any 401 as "start OAuth" and fails to register, so the token-in-URL version was dropped (PR #50). It exposes only reference tools, sheet tools and hub tools, never shipment documents. The user explicitly accepted that anyone with the URL can list sheet shipments.

## Consequences

Every anonymous call to `uktzed_lookup_code` spends the server's Anthropic key. `/api/mcp` has its own CORS rule (`*`, no credentials).
