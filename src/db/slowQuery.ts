/**
 * Slow-query timing for the pg pool. Kept free of config/pool imports so it is
 * unit-testable. SECURITY: only the duration and the first SQL_PREVIEW_CHARS of
 * the statement text are ever logged — query parameters can contain personal
 * data and are never read, copied or logged.
 */
export const SQL_PREVIEW_CHARS = 200;

export type SlowQueryReport = { ms: number; sql: string };

type QueryFn = (...args: any[]) => any;

/** First 200 chars of the SQL, whitespace collapsed. Never includes parameters. */
export function sqlPreview(first: unknown): string {
  const text = typeof first === 'string' ? first : (first as { text?: unknown } | null)?.text;
  return (typeof text === 'string' ? text : '<non-text query>').replace(/\s+/g, ' ').trim().slice(0, SQL_PREVIEW_CHARS);
}

/**
 * Wraps `target.query` (a pg Client/Pool method) so calls slower than
 * `thresholdMs` are reported. Behaviour is otherwise identical: same args, same
 * return value (promise, callback or Submittable stream), same errors.
 * A `thresholdMs` <= 0 disables timing entirely.
 */
export function instrumentQuery(
  target: { query: QueryFn },
  thresholdMs: number,
  onSlow: (r: SlowQueryReport) => void,
  now: () => number = () => performance.now(),
): void {
  if (!(thresholdMs > 0)) return;
  const original = target.query;
  target.query = function timedQuery(this: unknown, ...args: any[]) {
    const start = now();
    const report = () => {
      const ms = now() - start;
      if (ms >= thresholdMs) onSlow({ ms: Math.round(ms), sql: sqlPreview(args[0]) });
    };
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      // callback style
      args[args.length - 1] = function (this: unknown, ...cbArgs: any[]) {
        report();
        return last.apply(this, cbArgs);
      };
      return original.apply(this, args);
    }
    const result = original.apply(this, args);
    if (result && typeof result.then === 'function') {
      return result.then(
        (v: unknown) => (report(), v),
        (e: unknown) => {
          report();
          throw e;
        },
      );
    }
    return result; // Submittable / stream: not timed
  };
}

export function logSlowQuery({ ms, sql }: SlowQueryReport): void {
  // eslint-disable-next-line no-console
  console.warn(`[slow-query] ${ms}ms ${sql}`);
}
