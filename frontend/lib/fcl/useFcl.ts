"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { FclOverview, LotDetail } from "@/lib/types";

/**
 * The whole-FCL overview (GET /api/workspaces/:id/fcl) — shared by the «Партії»
 * and «Комплектність» tabs. `reload()` after any write; `version` bumps re-fetch
 * lot details too.
 */
export function useFclOverview(fclId: string | null) {
  const [overview, setOverview] = useState<FclOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!fclId) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const o = await api<FclOverview>(`/api/workspaces/${fclId}/fcl`);
      if (mine === seq.current) {
        setOverview(o);
        setVersion((v) => v + 1);
      }
    } catch {
      if (mine === seq.current) setOverview(null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [fclId]);

  useEffect(() => {
    setOverview(null);
    void reload();
  }, [reload]);

  return { overview, loading, reload, version };
}

/** One lot judged like a shipment (GET /api/workspaces/:id/lots/:lotId). */
export function useLotDetail(fclId: string | null, lotId: string | null, version: number) {
  const [detail, setDetail] = useState<LotDetail | null>(null);
  useEffect(() => {
    if (!fclId || !lotId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api<LotDetail>(`/api/workspaces/${fclId}/lots/${lotId}`)
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setDetail(null));
    return () => {
      cancelled = true;
    };
  }, [fclId, lotId, version]);
  return detail;
}
