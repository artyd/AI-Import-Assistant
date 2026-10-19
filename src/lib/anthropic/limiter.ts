import { config } from '../config.js';

/**
 * Process-wide concurrency gate for Anthropic calls.
 *
 * The indexing worker makes several vision/LLM calls per file (OCR, structured
 * field extraction, classification). With worker concurrency > 1 and a burst of
 * queued files, the number of *simultaneous* Anthropic requests can spike far
 * past what the account's rate limits tolerate — the SDK's own 429 retries then
 * spend the whole job attempt backing off, and files land in 'error'.
 *
 * This is a plain in-process semaphore: at most `ANTHROPIC_MAX_CONCURRENCY`
 * calls run at once; the rest queue FIFO. It bounds the fan-out that BullMQ's
 * per-job concurrency alone cannot see. It does NOT replace the SDK's retry
 * logic — it reduces how often that retry path is hit in the first place.
 *
 * In-process only: with multiple worker replicas each gets its own budget, so
 * keep the per-process cap comfortably under the account limit divided by the
 * replica count. A distributed limiter (Redis) is a later concern.
 */

let active = 0;
const waiters: Array<() => void> = [];

/** Runs `fn` once a concurrency slot is free, releasing the slot afterwards. */
export async function runWithAnthropicLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (active < config.ANTHROPIC_MAX_CONCURRENCY) {
    // Fast path: a slot is free — claim it.
    active += 1;
  } else {
    // Wait until a releaser hands us its slot. The slot is TRANSFERRED (the
    // releaser does not decrement and we do not increment), which avoids the
    // race where a fresh caller slips into the freed slot before we resume.
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) {
      next(); // transfer this slot to the next waiter; `active` stays the same
    } else {
      active -= 1; // no one waiting — free the slot
    }
  }
}

/** Current in-flight count — exposed for diagnostics/tests only. */
export function anthropicInFlight(): number {
  return active;
}
