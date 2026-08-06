---
description: Run the end-to-end API smoke test against a running stack
---

Run the API smoke test (`scripts/smoke-test.mjs`, wired as `npm run smoke`).

It needs a **running stack** and a **seeded user**. Requires env vars `EMAIL` and `PASSWORD`; optional `BASE_URL` (default `http://localhost:8080`), `SKIP_CHAT=1`, `INDEX_TIMEOUT_MS`.

Arguments (optional): $ARGUMENTS — treat as the target, e.g. a `BASE_URL` or `prod`.

Steps:
1. If no stack is reachable, tell the user to start one (`docker compose up -d --build`, or `npm run dev` + `npm run dev:worker`) and seed a user (`npm run seed -- <email> <password>`).
2. Run the smoke test with the provided/asked credentials. Since it needs interactive secrets, suggest the user run it themselves via `! EMAIL=... PASSWORD=... npm run smoke` if credentials aren't already in the environment.
3. Summarize the `[OK]`/`[FAIL]` results; if anything failed, investigate the relevant route/service.
