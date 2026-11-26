"use client";

import { useEffect, useState } from "react";

/**
 * True on touch / narrow screens: there the OS pickers (native <select>,
 * date input) stay — the mobile layout is frozen and they fit the device better.
 * Starts false so the first client render matches the server one.
 */
export function useNativeControls(): boolean {
  const [native, setNative] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse), (max-width: 760px)");
    const update = () => setNative(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return native;
}
