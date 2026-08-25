# Action Prompt — Phase 2: Retry-with-backoff on Voyage embeddings (429)

> Standalone action prompt. Root cause confirmed live: `error_reason` on the 3 files that survived
> a manual "Повторити невдалі" retry reads `Voyage embeddings failed (429): ...`. This is a small,
> self-contained fix — no schema change, no decision points, single file for the core fix.

## Root cause (confirmed, not a hypothesis)

`src/services/embeddings/voyage.ts::embedBatch()` throws immediately on any non-2xx response,
including 429 (rate limited). The only retry is BullMQ's job-level `attempts: 2, backoff:
{ type: 'exponential', delay: 2000 }` (`src/queue/index.ts`) — a single retry, 2 seconds later.
If Voyage's rate-limit window (per-minute, typical of lower/free tiers) hasn't cleared in those 2
seconds, the retry hits the same 429 and the file permanently lands in `status = 'error'`.

This also explains the original batch failure and the partial recovery on manual retry: both the
sidebar's "Повторити невдалі" (`mapLimit` concurrency 4) and the worker itself
(`concurrency: 3` in `src/worker/index.ts`) fire several embedding calls at once, which is exactly
what trips a per-minute rate limit in a burst.

## Role & constraints

Same stack/conventions as `phase-1-action-prompt.md`: Fastify + TypeScript, ESM/NodeNext, strict
TS. **Stop at `npm run typecheck` + `npm run build` green.** No production migration/live-test
needed for this phase — it's pure application logic, no schema change.

## Goal

Make `VoyageEmbeddingProvider.embed()` transparently wait and retry on 429/5xx **within a single
job attempt**, instead of failing immediately and relying on BullMQ's coarse 2-second job retry.

## Part 1 — Retry-with-backoff in `src/services/embeddings/voyage.ts`

Replace `embedBatch()`'s error handling with a bounded retry loop. Behavior:

- Retry only on **429** or **5xx** (502/503/504 etc.) — never on other 4xx (bad request, auth
  errors, etc. are not transient; retrying wastes time and hides real bugs).
- Prefer the `Retry-After` response header when Voyage sends one (seconds); otherwise fall back to
  exponential backoff with jitter, capped.
- Bounded: `MAX_RETRIES = 5`, base delay `1000ms`, cap `30_000ms` per wait. Worst case adds a few
  minutes before giving up — acceptable for a background worker job, not a user-facing request.
- On final failure, throw the same `Voyage embeddings failed (${status}): ${body}` shape as today,
  so `error_reason` stays equally readable.
- Log each retry (`console.warn`) so it's visible in worker logs, matching the existing
  `console.error`/`console.log` conventions already used in `worker/index.ts`.

```ts
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const BATCH = 64;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
  }
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return exp + Math.random() * 500; // jitter, avoids synchronized retries across concurrent jobs
}

// ... inside VoyageEmbeddingProvider ...

private async embedBatch(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.EMBEDDING_API_KEY}`,
      },
      body: JSON.stringify({ input: texts, model: this.model, input_type: inputType }),
    });

    if (res.ok) {
      const json = (await res.json()) as VoyageResponse;
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }

    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    const body = await res.text().catch(() => '');
    lastError = new Error(`Voyage embeddings failed (${res.status}): ${body.slice(0, 300)}`);

    if (!retryable || attempt === MAX_RETRIES) throw lastError;

    const delay = retryDelayMs(attempt, res.headers.get('retry-after'));
    // eslint-disable-next-line no-console
    console.warn(
      `Voyage embeddings ${res.status}, retrying in ${Math.round(delay)}ms ` +
        `(attempt ${attempt + 1}/${MAX_RETRIES})`,
    );
    await sleep(delay);
  }

  throw lastError ?? new Error('Voyage embeddings failed after retries');
}
```

Keep everything else in the file (`MODEL_DIMENSIONS`, the outer `embed()` batching loop that calls
`embedBatch()` per chunk of `BATCH`, the `VoyageResponse` interface) unchanged.

## Part 2 (optional, verify before shipping) — don't flash `error` mid-retry

`src/worker/index.ts::processJob()` calls `setStatus(..., 'error', reason)` on the **first**
failure, before BullMQ's own job-level retry (`attempts: 2`) even runs — so if that BullMQ retry
were to succeed, the UI would still have briefly shown "error" for no reason. Now that Part 1
absorbs 429/5xx internally, BullMQ's job-level retry becomes a rare last-resort case, so this is
lower priority — but if you want to close the gap:

`job` (the `Job<IndexJobData>` parameter of `processJob`) exposes `job.attemptsMade` and
`job.opts.attempts`. **Check the exact semantics for the installed BullMQ version** (whether
`attemptsMade` counts the in-progress attempt or only completed ones) before wiring a condition
like "only persist `status='error'` when this is the final attempt" — get this wrong and a
genuinely-failed file could stay silently `queued`/`indexing` forever instead of surfacing as
`error`. If the semantics can't be confirmed confidently, skip this part; Part 1 alone already
fixes the reported bug.

## When you're done

`npm run typecheck && npm run build` green. Then, to confirm the fix without touching production:
if you have a way to simulate a 429 locally (e.g. a quick standalone script hitting a local mock
server), do that; otherwise state clearly that Part 1 was verified by type/build only and ask
before deploying/retrying against the 3 real failed files in shipment №2026-1308.
