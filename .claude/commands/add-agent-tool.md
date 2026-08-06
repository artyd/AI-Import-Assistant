---
description: Scaffold a new tool for the Штурман agent following the codebase pattern
---

Add a new agent tool named: **$ARGUMENTS**

Follow the existing pattern exactly (see `src/agent/tools.ts`):

1. Add an `Anthropic.Tool` entry to `toolDefinitions` — Ukrainian `description` that states WHEN to call it (not just what it does), and a JSON `input_schema`.
2. Add a `case` in `executeTool(name, input, ctx)` that returns a `ToolOutcome`:
   `{ result: string, summary: string, citations: Citation[] }`
   - `result` → text the model sees; `summary` → short line for the `tool_result` SSE event / agent log; `citations` → `{ file, page }[]` for source chips.
3. Respect the hard constraints in `CLAUDE.md`: single agent, keep `search_documents` + `read_file` intact, workspace-scoped via `ctx.workspaceId`.
4. Run `/verify`.

Do NOT change the SSE event names or the `done` payload shape — the frontend depends on them.
