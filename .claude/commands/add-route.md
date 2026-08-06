---
description: Scaffold a new REST route following the codebase conventions
---

Add a new REST route: **$ARGUMENTS**

Conventions (mirror `src/routes/workspaces.ts` / `files.ts`):

1. Create `src/routes/<name>.ts` exporting `async function <name>Routes(app: FastifyInstance)`.
2. `app.addHook('preHandler', authenticate)` (all routes need auth except login).
3. Validate the body/params/query with `zod`; return `400 { error: 'invalid_request', issues }` on failure.
4. For workspace-scoped routes, load `getOwnedWorkspace(req.user!.sub, id)` and `404` if null — never leak another user's data.
5. Register the plugin in `src/server.ts`.
6. Remember ESM: local imports end in `.js`.
7. Update `API_CONTRACT.md` with the new endpoint (request/response shape).
8. Run `/verify`.
