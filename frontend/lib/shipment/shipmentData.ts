// The open shipment's server-side verdict data — completeness checklist, risks
// and parties — shared by the top bar and the shipment panel. One fetch per
// change; anything that changes the shipment out of band (an agent turn, the
// survey) calls `invalidate()` instead of bumping a counter through props.

import { create } from "zustand";
import { api } from "@/lib/api";
import type { ChecklistItem, Party, Risk } from "@/lib/types";

interface ShipmentDataState {
  workspaceId: string | null;
  /** Bumped by invalidate(): the panel re-seeds its edit forms from the server. */
  revision: number;
  checklist: ChecklistItem[] | null;
  risks: Risk[] | null;
  /** Server copy; null while loading. */
  parties: Party[] | null;

  /** Load everything for a shipment (call when it opens). */
  load: (workspaceId: string) => Promise<void>;
  /** The shipment changed out of band: reload everything and bump the revision. */
  invalidate: () => void;
  /** Reload only the checklist (e.g. after a workspace patch). */
  refreshChecklist: () => Promise<void>;
  /** Reload only the risks; rejects on failure so callers can report it. */
  reloadRisks: () => Promise<void>;
}

export const useShipmentData = create<ShipmentDataState>()((set, get) => {
  // Responses for a shipment the user already left are dropped.
  const stillOpen = (id: string) => get().workspaceId === id;

  const fetchChecklist = (id: string) =>
    api<{ items: ChecklistItem[] }>(`/api/workspaces/${id}/checklist`)
      .then((r) => stillOpen(id) && set({ checklist: r.items }))
      .catch(() => stillOpen(id) && set({ checklist: null }));
  const fetchRisks = (id: string) =>
    api<{ risks: Risk[] }>(`/api/workspaces/${id}/risks`)
      .then((r) => stillOpen(id) && set({ risks: r.risks }))
      .catch(() => stillOpen(id) && set({ risks: null }));
  const fetchParties = (id: string) =>
    api<{ parties: Party[] }>(`/api/workspaces/${id}/parties`)
      .then((r) => stillOpen(id) && set({ parties: r.parties }))
      .catch(() => stillOpen(id) && set({ parties: [] }));

  const loadAll = async (id: string) => {
    set({ parties: null });
    await Promise.all([fetchChecklist(id), fetchRisks(id), fetchParties(id)]);
  };

  return {
    workspaceId: null,
    revision: 0,
    checklist: null,
    risks: null,
    parties: null,

    load: async (workspaceId) => {
      if (get().workspaceId !== workspaceId) {
        set({ workspaceId, checklist: null, risks: null, parties: null, revision: get().revision + 1 });
      }
      await loadAll(workspaceId);
    },
    invalidate: () => {
      const id = get().workspaceId;
      if (!id) return;
      set({ revision: get().revision + 1 });
      void loadAll(id);
    },
    refreshChecklist: async () => {
      const id = get().workspaceId;
      if (id) await fetchChecklist(id);
    },
    reloadRisks: async () => {
      const id = get().workspaceId;
      if (!id) return;
      const r = await api<{ risks: Risk[] }>(`/api/workspaces/${id}/risks`);
      if (stillOpen(id)) set({ risks: r.risks });
    },
  };
});
