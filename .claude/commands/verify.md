---
description: Typecheck + build the backend, and report any errors
---

Verify the backend is healthy after changes:

1. Run `npm run typecheck` and fix any type errors.
2. Run `npm run build` and confirm it emits `dist/server.js`, `dist/worker/index.js`, and `dist/db/schema.sql`.
3. Report a concise pass/fail summary. Do not start servers or Docker.

If a running stack is available and the user wants a full end-to-end check, suggest `/smoke` instead.
