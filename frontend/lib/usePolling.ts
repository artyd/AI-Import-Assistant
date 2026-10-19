"use client";

import { useEffect, useRef } from "react";

/**
 * Run `fn` now and then every `ms` while mounted (and `enabled`). The latest
 * `fn` is always called, so callers don't need to memoise it for correctness.
 */
export function usePolling(fn: () => void, ms: number, enabled = true): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return;
    latest.current();
    const t = setInterval(() => latest.current(), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
}
