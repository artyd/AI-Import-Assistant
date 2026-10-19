// The supplier-instruction editing session (pure): which version is shown, the
// draft on screen, whether it has unsaved edits, and which of Штурман's
// proposals the user already resolved. The page dispatches; the rules live here.

import { setField, type InstructionDraft, type InstructionVersion } from "@/lib/instruction";

export interface SessionState {
  versions: InstructionVersion[];
  /** The version on screen; null = an unsaved prefill. */
  current: InstructionVersion | null;
  draft: InstructionDraft | null;
  dirty: boolean;
  /** Proposal paths accepted/rejected since the last save (server owns proposals). */
  resolved: string[];
}

export type SessionAction =
  | { type: "loaded"; versions: InstructionVersion[]; prefill?: InstructionDraft }
  | { type: "edit"; fn: (d: InstructionDraft) => InstructionDraft }
  | { type: "accept"; index: number }
  | { type: "reject"; index: number }
  | { type: "saved"; version: InstructionVersion }
  | { type: "statusChanged"; version: InstructionVersion }
  | { type: "opened"; version: InstructionVersion }
  /** Штурман answered: the server's versions, newest first. */
  | { type: "synced"; versions: InstructionVersion[] };

export const emptySession: SessionState = { versions: [], current: null, draft: null, dirty: false, resolved: [] };

/** An approved or sent version is the compliance reference — never edited in place. */
export function isLocked(s: Pick<SessionState, "current">): boolean {
  return s.current?.status === "approved" || s.current?.status === "sent";
}

const byNewest = (vs: InstructionVersion[]) => [...vs].sort((a, b) => b.version - a.version);

export function sessionReducer(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case "loaded": {
      const latest = a.versions[0] ?? null;
      return { versions: a.versions, current: latest, draft: latest ? latest.draft : (a.prefill ?? null), dirty: false, resolved: [] };
    }
    case "edit":
      return s.draft ? { ...s, draft: a.fn(s.draft), dirty: true } : s;
    case "accept": {
      const p = s.draft?.proposals[a.index];
      if (!s.draft || !p) return s;
      const next = setField(s.draft, p.path, p.value, "documents");
      next.proposals = s.draft.proposals.filter((_, j) => j !== a.index);
      return { ...s, draft: next, dirty: true, resolved: [...s.resolved, p.path] };
    }
    case "reject": {
      if (!s.draft) return s;
      const p = s.draft.proposals[a.index];
      return {
        ...s,
        draft: { ...s.draft, proposals: s.draft.proposals.filter((_, j) => j !== a.index) },
        dirty: true,
        resolved: p ? [...s.resolved, p.path] : s.resolved,
      };
    }
    case "saved": {
      const v = a.version;
      return {
        versions: byNewest([v, ...s.versions.filter((x) => x.version !== v.version)]),
        current: v,
        // Keep the screen's fields; take the server's proposals (Штурман may have added some).
        draft: s.draft ? { ...s.draft, proposals: v.draft.proposals } : v.draft,
        dirty: false,
        resolved: [],
      };
    }
    case "statusChanged":
      return { ...s, current: a.version, versions: s.versions.map((x) => (x.version === a.version.version ? a.version : x)) };
    case "opened":
      return { ...s, current: a.version, draft: a.version.draft, dirty: false };
    case "synced": {
      const latest = a.versions[0];
      if (!latest) return s;
      const pending = latest.draft.proposals.filter((p) => !s.resolved.includes(p.path));
      if (!s.current || latest.version > s.current.version) {
        // Штурман wrote into a newer draft version (e.g. the shown one was approved).
        return {
          ...s,
          versions: a.versions,
          current: latest,
          draft: s.draft ? { ...s.draft, proposals: pending } : latest.draft,
        };
      }
      if (latest.version === s.current.version) {
        return { ...s, versions: a.versions, draft: s.draft ? { ...s.draft, proposals: pending } : s.draft };
      }
      return { ...s, versions: a.versions };
    }
  }
}

/** What "save" must do now. */
export type SaveRequest =
  | { kind: "none"; version: InstructionVersion }
  | { kind: "create"; draft: InstructionDraft }
  | { kind: "update"; version: number; draft: InstructionDraft; resolvedProposals: string[] };

export function saveRequest(s: SessionState): SaveRequest | null {
  if (!s.draft) return null;
  if (s.current && !s.dirty) return { kind: "none", version: s.current };
  if (!s.current || isLocked(s)) return { kind: "create", draft: s.draft };
  return { kind: "update", version: s.current.version, draft: s.draft, resolvedProposals: [...s.resolved] };
}
