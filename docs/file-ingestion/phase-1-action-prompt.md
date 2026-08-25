# Action Prompt — Phase 1: Content-hash dedup + `normalize_shipment_files` chat tool

> Standalone action prompt derived from the file-ingestion-robustness audit
> (`00-audit-and-plan.md`). Scope is intentionally small and additive: stop the same file from
> being indexed twice under different names/folders, and give Shturman a chat command to backfill
> this for already-uploaded shipments. **Do not** add filename sanitization/renaming — the audit
> found it isn't needed (see Finding F1–F3 in the audit doc).

## Role & constraints

You are working in the **AI Import Assistant** backend (Fastify + TypeScript, ESM/NodeNext,
Postgres via `pg`, BullMQ worker, Qdrant, Voyage AI embeddings).

Hard rules for this task:
- **Additive / non-destructive only.** Production is the only live environment; no data loss. The
  new dedup logic must never delete or overwrite an existing file — it only *skips creating a new
  one* when the content already exists, and reports that back.
- The schema has **no versioned migrations** — `src/db/schema.sql` is re-run whole on every boot
  and must stay **idempotent** (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- ESM local imports end in `.js`. Validate any new request bodies with `zod`. Strict TS.
- **Stop at `npm run typecheck` + `npm run build` green.** Do not run migrations against
  production and do not live-test against prod data/files.
- Do not commit unless explicitly asked.

## Goal

1. A `content_hash` column so exact-duplicate uploads (same bytes, any name/folder) are detected
   and skipped instead of silently double-indexed.
2. A new agent tool, `normalize_shipment_files`, callable from the Shturman chat, that:
   - backfills `content_hash` for files uploaded before this change,
   - reports (never auto-deletes) any duplicate groups it finds,
   - bulk-retries any file currently `status = 'error'` in the shipment.

---

## Part 1 — Schema

Append to `src/db/schema.sql`, near the existing "File versioning" block (`:81-84`), following the
same idempotent pattern:

```sql
-- Content-hash dedup (file-normalization phase 1).
ALTER TABLE files ADD COLUMN IF NOT EXISTS content_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_files_workspace_hash ON files(workspace_id, content_hash)
  WHERE is_latest = true;
```

`content_hash` is nullable (existing rows won't have it until the backfill in Part 4 runs).

## Part 2 — Hash helper (`src/services/storage.ts`)

Add, near the other exports:

```ts
import { createHash } from 'node:crypto';

/** SHA-256 of a file's bytes, used for exact-content dedup. */
export function contentHashOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
```

Reused by both the upload path (Part 3) and the backfill (Part 4) — do not duplicate the hashing
logic.

## Part 3 — Upload-path dedup (`src/routes/files.ts`)

In the `POST /api/workspaces/:id/files` handler, inside the `for await (const part of req.files())`
loop:

1. Import `contentHashOf` from `../services/storage.js`.
2. Right after `buf = await part.toBuffer()` succeeds and the truncated check passes, compute
   `const hash = contentHashOf(buf);`.
3. Track duplicates **within the same upload batch** (a user can select several files at once, two
   of which are identical) with a `Map<string, string>` declared once above the loop:
   `const seenHashes = new Map<string, string>(); // hash -> name of the first occurrence`.
4. Dedup only applies to a **fresh** upload — i.e. when this part is *not* fulfilling
   `replacesFileId` (an explicit version-replace is a deliberate user action; never second-guess
   it). Concretely: skip the dedup check entirely when `replacesFileId` was provided on the
   request at all (`req.query.replacesFileId`), not just for the specific part that consumes it.
5. When dedup applies, before calling `storeFile()`:
   ```ts
   if (!req.query.replacesFileId) {
     const inBatch = seenHashes.get(hash);
     if (inBatch) {
       rejected.push({ name, reason: `duplicate_of:${inBatch}` });
       continue;
     }
     const { rows: dup } = await query<{ name: string }>(
       `SELECT name FROM files
        WHERE workspace_id = $1 AND content_hash = $2 AND is_latest = true LIMIT 1`,
       [ws.id, hash],
     );
     if (dup[0]) {
       rejected.push({ name, reason: `duplicate_of:${dup[0].name}` });
       continue;
     }
   }
   ```
6. On the normal (non-duplicate) path, add `hash` to the `INSERT INTO files (...)` column list /
   `content_hash` value, and record it: `seenHashes.set(hash, name);` right after the insert
   succeeds.

No frontend change is required: `frontend/app/workspaces/[id]/page.tsx:209-214` already surfaces
every `rejected` entry via `alert("Відхилено:\n" + res.rejected.map(r => \`• ${r.name} — ${r.reason}\`)...)`,
so a `duplicate_of:<name>` reason will show up automatically. If you'd rather return structured
data (`{ name, reason: 'duplicate', duplicateOfId, duplicateOfName }`) and have the frontend render
it more nicely, that's a reasonable improvement — just note it as a follow-up rather than blocking
this phase on a frontend change.

## Part 4 — `normalize_shipment_files` agent tool (`src/agent/tools.ts`)

Mirror the existing `sort_inbox` tool exactly (definition shape, dispatcher `case`, handler
function signature) — see `:145-150` (definition) and `:204` / `runSortInbox` (`:421-435`) for the
pattern to copy.

**1. Tool definition** (add to `toolDefinitions`, near `sort_inbox`):

```ts
{
  name: 'normalize_shipment_files',
  description:
    'Перевіряє файли поточного постачання на точні дублікати за вмістом (не за іменем) та ' +
    'донараховує відсутні хеші для файлів, завантажених до цієї функції. Ніколи не видаляє ' +
    'файли — лише повідомляє про знайдені дублікати. Також повторно запускає індексацію всіх ' +
    'файлів зі статусом «Помилка». Використовуй за проханням «нормалізуй файли», «перевір ' +
    'дублікати», «повтори невдалі файли» тощо.',
  input_schema: { type: 'object', properties: {} },
},
```

**2. Dispatcher** — add `case 'normalize_shipment_files': return runNormalizeShipmentFiles(ctx);`
next to the `sort_inbox` case.

**3. Handler** — new function, same file, modeled on `runSortInbox`:

```ts
async function runNormalizeShipmentFiles(ctx: ToolContext): Promise<ToolOutcome> {
  // 1. Backfill content_hash for files that predate this feature.
  const { rows: unhashed } = await query<{ id: string; disk_path: string }>(
    `SELECT id, disk_path FROM files
     WHERE workspace_id = $1 AND is_latest = true AND content_hash IS NULL`,
    [ctx.workspaceId],
  );
  let backfilled = 0;
  for (const f of unhashed) {
    try {
      const buf = await readStoredFile(f.disk_path);
      await query('UPDATE files SET content_hash = $2 WHERE id = $1', [f.id, contentHashOf(buf)]);
      backfilled++;
    } catch {
      // Stored bytes missing/unreadable — skip; not fatal for the rest of the sweep.
    }
  }

  // 2. Report (never delete) duplicate groups among is_latest files.
  const { rows: dupGroups } = await query<{ content_hash: string; names: string[]; ids: string[] }>(
    `SELECT content_hash, array_agg(name ORDER BY created_at) AS names, array_agg(id ORDER BY created_at) AS ids
     FROM files
     WHERE workspace_id = $1 AND is_latest = true AND content_hash IS NOT NULL
     GROUP BY content_hash HAVING COUNT(*) > 1`,
    [ctx.workspaceId],
  );

  // 3. Bulk-retry currently-errored files (same primitive as POST …/reindex).
  const { rows: errored } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM files WHERE workspace_id = $1 AND status = 'error'`,
    [ctx.workspaceId],
  );
  for (const f of errored) {
    await query(`UPDATE files SET status = 'queued', error_reason = NULL WHERE id = $1`, [f.id]);
    await enqueueIndexJob(f.id);
    await publishFileStatus(ctx.workspaceId, { fileId: f.id, status: 'queued', name: f.name });
  }

  const lines: string[] = [];
  lines.push(`Донараховано хешів: ${backfilled}.`);
  if (dupGroups.length === 0) {
    lines.push('Дублікатів за вмістом не знайдено.');
  } else {
    lines.push(
      `Знайдено груп дублікатів: ${dupGroups.length} (файли НЕ видалено, це лише звіт):`,
    );
    for (const g of dupGroups) lines.push(`- ${g.names.map((n) => `«${n}»`).join(' = ')}`);
  }
  lines.push(`Поставлено на повторну індексацію (були в статусі «Помилка»): ${errored.length}.`);

  return {
    result: lines.join('\n'),
    summary: `Нормалізація: хешів +${backfilled}, дублікатів ${dupGroups.length}, повторно проіндексовано ${errored.length}`,
    citations: [],
  };
}
```

Add the two new imports this needs at the top of `tools.ts`: `contentHashOf` from
`../services/storage.js`, `enqueueIndexJob` from `../queue/index.js`, `publishFileStatus` from
`../events/fileStatus.js` (check each isn't already imported before adding — `readStoredFile` and
`query` already are).

## Part 5 (optional, not required for this phase)

If useful later, the same `runNormalizeShipmentFiles` logic could be exposed as
`POST /api/workspaces/:id/normalize` in `src/routes/files.ts` (thin wrapper, same pattern as the
existing `/sort-inbox` route) so the sidebar could eventually get a button too, not only chat.
Skip this unless asked — the chat tool alone satisfies the current ask.

## When you're done

Run `npm run typecheck && npm run build` and confirm both are green. Do **not** run
`npm run migrate` against the production DB and do not call `normalize_shipment_files` against a
live shipment as a test — describe what you verified locally/via read-only inspection instead, and
stop there per the hard rules above.
