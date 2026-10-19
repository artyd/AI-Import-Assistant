import { describe, expect, it } from "vitest";
import type { InstructionDraft, InstructionVersion } from "@/lib/instruction";
import { emptySession, isLocked, saveRequest, sessionReducer, type SessionState } from "../instructionSession";

const draft = (proposals: { path: string; value: string }[] = []) =>
  ({ supplierEmail: "", extra: [], proposals, supplierName: "" }) as unknown as InstructionDraft;
const ver = (version: number, status: InstructionVersion["status"] = "draft", d = draft()) =>
  ({ version, status, draft: d }) as InstructionVersion;

const loaded = (versions: InstructionVersion[], prefill?: InstructionDraft) =>
  sessionReducer(emptySession, { type: "loaded", versions, prefill });

describe("instruction session", () => {
  it("opens the newest version, or the prefill when there is none", () => {
    expect(loaded([ver(2), ver(1)]).current?.version).toBe(2);
    const fresh = loaded([], draft());
    expect(fresh.current).toBeNull();
    expect(fresh.draft).not.toBeNull();
  });

  it("an approved or sent version is never edited in place: saving forks a new version", () => {
    const s = sessionReducer(loaded([ver(1, "approved")]), { type: "edit", fn: (d) => ({ ...d, supplierEmail: "a@b" }) });
    expect(isLocked(s)).toBe(true);
    expect(saveRequest(s)?.kind).toBe("create");
  });

  it("a clean shown version needs no save; an edited draft version is updated with resolved proposals", () => {
    expect(saveRequest(loaded([ver(1)]))?.kind).toBe("none");
    const s = sessionReducer(loaded([ver(1, "draft", draft([{ path: "a", value: "1" }]))]), { type: "reject", index: 0 });
    expect(saveRequest(s)).toMatchObject({ kind: "update", version: 1, resolvedProposals: ["a"] });
  });

  it("resolved proposals are never re-added by a sync", () => {
    const withTwo = draft([{ path: "a", value: "1" }, { path: "b", value: "2" }]);
    let s: SessionState = loaded([ver(1, "draft", withTwo)]);
    s = sessionReducer(s, { type: "reject", index: 0 });
    s = sessionReducer(s, { type: "synced", versions: [ver(1, "draft", withTwo)] });
    expect(s.draft?.proposals.map((p) => p.path)).toEqual(["b"]);
  });

  it("a newer server version replaces the shown one but keeps the screen's fields", () => {
    let s = sessionReducer(loaded([ver(1, "approved")]), { type: "edit", fn: (d) => ({ ...d, supplierEmail: "kept@x" }) });
    s = sessionReducer(s, { type: "synced", versions: [ver(2, "draft", draft([{ path: "c", value: "3" }])), ver(1, "approved")] });
    expect(s.current?.version).toBe(2);
    expect(s.draft?.supplierEmail).toBe("kept@x");
    expect(s.draft?.proposals.map((p) => p.path)).toEqual(["c"]);
  });

  it("dirty clears only on save or open, and saving takes the server's proposals", () => {
    let s = sessionReducer(loaded([ver(1)]), { type: "edit", fn: (d) => ({ ...d, supplierEmail: "x" }) });
    expect(s.dirty).toBe(true);
    s = sessionReducer(s, { type: "statusChanged", version: ver(1, "approved") });
    expect(s.dirty).toBe(true);
    s = sessionReducer(s, { type: "saved", version: ver(2, "draft", draft([{ path: "n", value: "v" }])) });
    expect(s).toMatchObject({ dirty: false, resolved: [] });
    expect(s.draft?.supplierEmail).toBe("x");
    expect(s.draft?.proposals.map((p) => p.path)).toEqual(["n"]);
    expect(s.versions.map((v) => v.version)).toEqual([2, 1]);
  });
});
