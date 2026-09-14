// App-wide domain store (ШТУРМАН prototype port · Phase A).
//
// This holds ONLY the new cross-cutting concepts the prototype introduced:
//   - chatKind   : which of the three chat kinds is active (normal/supply/consolidated)
//   - view       : top-level view routing (chat / news / map)
//   - collections + activeCollectionId : the Збірник entity
//
// Per-workspace state (workspace, folders, files, checklist, conversations) stays
// where it is, in `app/workspaces/[id]/page.tsx`. Theme/auth stay in their Contexts.
//
// chatKind + activeCollectionId are persisted (localStorage) so the shell reopens
// on the kind/entity the user last used, matching the prototype's `persist()`.
// `view` is intentionally NOT persisted — we never want to strand a reload on
// News/Map; the app always reopens on the chat view.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ChatKind, Collection } from "./types";

export type AppView = "chat" | "news" | "map";

interface AppState {
  chatKind: ChatKind;
  view: AppView;
  collections: Collection[];
  activeCollectionId: string | null;

  setChatKind: (k: ChatKind) => void;
  setView: (v: AppView) => void;
  setCollections: (c: Collection[]) => void;
  addCollection: (c: Collection) => void;
  removeCollection: (id: string) => void;
  setActiveCollectionId: (id: string | null) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      chatKind: "supply",
      view: "chat",
      collections: [],
      activeCollectionId: null,

      // Switching kind always returns to the chat view (prototype `setChatType`).
      setChatKind: (chatKind) => set({ chatKind, view: "chat" }),
      setView: (view) => set({ view }),
      setCollections: (collections) => set({ collections }),
      addCollection: (c) =>
        set((s) => ({ collections: [c, ...s.collections], activeCollectionId: c.id })),
      removeCollection: (id) =>
        set((s) => {
          const collections = s.collections.filter((c) => c.id !== id);
          const activeCollectionId =
            s.activeCollectionId === id ? (collections[0]?.id ?? null) : s.activeCollectionId;
          return { collections, activeCollectionId };
        }),
      setActiveCollectionId: (activeCollectionId) => set({ activeCollectionId }),
    }),
    {
      name: "shturman-app",
      storage: createJSONStorage(() => localStorage),
      // Only persist the durable selections, not the fetched collections list or view.
      partialize: (s) => ({
        chatKind: s.chatKind,
        activeCollectionId: s.activeCollectionId,
      }),
    }
  )
);

/** Resolve the active collection object from the store (helper for components). */
export function selectActiveCollection(s: AppState): Collection | null {
  return s.collections.find((c) => c.id === s.activeCollectionId) ?? null;
}
