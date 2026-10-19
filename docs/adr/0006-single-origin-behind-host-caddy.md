# One origin behind the host's system Caddy

The backend (`127.0.0.1:8006`) and the frontend (`127.0.0.1:8007`) are served from one domain by the host's own Caddy: `/api/*` and `/health` go to the backend, everything else to the frontend. The browser uses relative `/api/...` paths. Caddy is not part of `docker-compose.yml`, because it is shared with other sites on the server. Vercel was dropped.

## Consequences

CORS matters only for real cross-origin callers (claude.ai on `/api/mcp`). A stale `CORS_ORIGIN` in the server `.env` makes every browser POST return 500.
