"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SupplyApiError, getSupplyToken, setSupplyToken, supplyApi } from "./api";
import type { ShipmentDraft, SupplyData, SupplyMarks, SupplySettings, SupplyShipment } from "./types";

const POLL_MS = 30_000;

/**
 * The register's state, always from the server. Polls the revision every 30 s
 * and reloads when someone else changed something. `editing` is the UI mode;
 * `canEdit` is what the server says the current token allows.
 */
export function useSupply() {
  const [data, setData] = useState<SupplyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [codeLength, setCodeLength] = useState<number | null>(null);
  const [codeLogin, setCodeLogin] = useState(true);
  const rev = useRef<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const d = await supplyApi.load();
      rev.current = d.revision;
      setData(d);
      setError(null);
      if (!d.canEdit) setEditing(false);
      return d;
    } catch {
      setError("Не вдалося завантажити реєстр. Перевірте звʼязок і спробуйте ще раз.");
      return null;
    }
  }, []);

  useEffect(() => {
    void reload();
    supplyApi
      .session()
      .then((s) => {
        setCodeLength(s.codeLength);
        setCodeLogin(s.codeLogin);
        // A still-valid supply token from earlier keeps the editor in edit mode.
        if (s.canEdit && getSupplyToken()) setEditing(true);
      })
      .catch(() => undefined);
  }, [reload]);

  useEffect(() => {
    const t = setInterval(async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const { revision } = await supplyApi.revision();
        if (revision !== rev.current) await reload();
      } catch {
        /* offline for a moment: try again next tick */
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  /** Enter edit mode: no code needed when the token already allows it. */
  const unlock = useCallback(
    async (code?: string): Promise<"ok" | "need_code"> => {
      if (code) {
        const t = await supplyApi.unlock(code);
        setSupplyToken(t);
      } else if (!data?.canEdit) {
        return "need_code";
      }
      const d = await reload();
      if (d?.canEdit) {
        setEditing(true);
        return "ok";
      }
      return "need_code";
    },
    [data?.canEdit, reload],
  );

  const lock = useCallback(() => {
    setSupplyToken(null);
    setEditing(false);
    void reload();
  }, [reload]);

  const replace = useCallback((s: SupplyShipment) => {
    setData((d) => (d ? { ...d, shipments: d.shipments.some((x) => x.id === s.id) ? d.shipments.map((x) => (x.id === s.id ? s : x)) : [...d.shipments, s] } : d));
  }, []);

  /** Run a write; on 401 drop to view mode, then always resync the revision. */
  const write = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof SupplyApiError && e.status === 401) {
          setSupplyToken(null);
          setEditing(false);
        }
        throw e;
      } finally {
        supplyApi.revision().then((r) => (rev.current = r.revision)).catch(() => undefined);
      }
    },
    [],
  );

  const create = useCallback(async (draft: ShipmentDraft) => write(async () => {
    const { shipment } = await supplyApi.create(draft);
    replace(shipment);
    return shipment;
  }), [replace, write]);

  const update = useCallback(async (s: SupplyShipment, patch: Partial<ShipmentDraft>, guard = true) => write(async () => {
    const { shipment } = await supplyApi.update(s.id, { ...patch, ...(guard ? { expectedUpdatedAt: s.updatedAt } : {}) });
    replace(shipment);
    return shipment;
  }), [replace, write]);

  /** Star / groups / transport: saved at once, no edit-conflict check. */
  const marks = useCallback(async (s: SupplyShipment, m: SupplyMarks) => write(async () => {
    const { shipment } = await supplyApi.marks(s.id, m);
    replace(shipment);
    return shipment;
  }), [replace, write]);

  const archive = useCallback(async (s: SupplyShipment, archived: boolean) => write(async () => {
    const { shipment } = await supplyApi.archive(s.id, archived);
    replace(shipment);
    return shipment;
  }), [replace, write]);

  const saveSettings = useCallback(async (settings: SupplySettings) => write(async () => {
    const r = await supplyApi.saveSettings(settings);
    setData((d) => (d ? { ...d, settings: r.settings } : d));
    return r.settings;
  }), [write]);

  /** Undo the newest history entry about this shipment (the toast's «Скасувати»). */
  const undoLast = useCallback(async (shipmentId: string | null) => write(async () => {
    const { history } = await supplyApi.history(shipmentId ?? undefined);
    const last = history.find((h) => h.undoable && (shipmentId ? h.shipmentId === shipmentId : h.kind === "settings"));
    if (last) await supplyApi.undo(last.id);
    await reload();
  }), [reload, write]);

  const undo = useCallback(async (historyId: number) => write(async () => {
    await supplyApi.undo(historyId);
    await reload();
  }), [reload, write]);

  return { data, error, editing, codeLength, codeLogin, reload, unlock, lock, create, update, marks, archive, saveSettings, undoLast, undo };
}

export type SupplyStore = ReturnType<typeof useSupply>;
