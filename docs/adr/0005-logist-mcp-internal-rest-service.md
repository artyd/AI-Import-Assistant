# External reference tools run as an internal plain-REST service

The Python reference scrapers (qdpro, dual-use, NBU, PubChem) live in `logist-mcp/`, run as an internal-only Compose service (no host port, no Caddy route), and are called from TypeScript over plain REST (`LOGIST_MCP_URL`). They are wrapped as ordinary agent tools. The native Anthropic MCP connector and an MCP client SDK were rejected to keep dependencies low and the tools testable, and to add nothing to the shared host's public surface.

## Consequences

The tools are enabled only when `LOGIST_MCP_URL` is set. `drlz_*` is not exposed, because the native drug registry already covers the medicines register (reconcile, don't duplicate).
