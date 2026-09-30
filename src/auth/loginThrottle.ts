/**
 * Login brute-force protection.
 *
 * - `loginRateLimit` — @fastify/rate-limit route config: per client IP
 *   (req.ip is the real client because server.ts sets trustProxy).
 * - Per-email lockout — after MAX_FAILURES wrong passwords for one email within
 *   WINDOW_MS, that email is locked for the rest of the window, whatever IP the
 *   attempts come from. In-memory: the API runs as a single process.
 */

export const loginRateLimit = { max: 10, timeWindow: '15 minutes' } as const;

const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;

const failures = new Map<string, { count: number; first: number }>();

function key(email: string): string {
  return email.trim().toLowerCase();
}

function current(email: string, now = Date.now()): { count: number; first: number } | null {
  const rec = failures.get(key(email));
  if (!rec) return null;
  if (now - rec.first > WINDOW_MS) {
    failures.delete(key(email));
    return null;
  }
  return rec;
}

export function isEmailLocked(email: string, now = Date.now()): boolean {
  return (current(email, now)?.count ?? 0) >= MAX_FAILURES;
}

export function recordLoginFailure(email: string, now = Date.now()): void {
  const rec = current(email, now);
  if (rec) rec.count += 1;
  else failures.set(key(email), { count: 1, first: now });
  // Bound memory under a spray of random emails.
  if (failures.size > 10_000) {
    for (const [k, v] of failures) if (now - v.first > WINDOW_MS) failures.delete(k);
  }
}

export function clearLoginFailures(email: string): void {
  failures.delete(key(email));
}

// ── Quick PIN login ──────────────────────────────────────────────────────────

/** Per-IP limit for the PIN endpoint (@fastify/rate-limit route config). */
export const codeLoginRateLimit = { max: 5, timeWindow: '15 minutes' } as const;

const CODE_WINDOW_MS = 24 * 60 * 60 * 1000;
let codeFailures: number[] = [];

function prune(now: number): void {
  codeFailures = codeFailures.filter((t) => now - t < CODE_WINDOW_MS);
}

/** Global (all-IP) lockout: too many wrong PINs in 24 h disables PIN login. */
export function isCodeLoginLocked(maxFailures: number, now = Date.now()): boolean {
  prune(now);
  return codeFailures.length >= maxFailures;
}

export function recordCodeFailure(now = Date.now()): void {
  prune(now);
  codeFailures.push(now);
}

/** Test hook. */
export function resetCodeFailures(): void {
  codeFailures = [];
}
