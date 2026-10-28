import { describe, expect, it } from "vitest";
import { journalRows, mergeJournal, readingState } from "../journal";
import type { FileItem, IngestEvent } from "@/lib/types";

const ev = (id: string, kind: IngestEvent["kind"], at: string, text = id): IngestEvent => ({
  id, fileId: null, batchId: null, kind, text, createdAt: at,
});

describe("reading journal", () => {
  it("maps kinds to Журнал dots and merges with chat rows by time", () => {
    const rows = journalRows([ev("1", "read", "2026-10-28T10:00:00Z"), ev("2", "file", "2026-10-28T10:02:00Z")]);
    expect(rows.map((r) => r.kind)).toEqual(["call", "result"]);
    const chat = [{ id: "c1", time: "", text: "tool", kind: "call" as "call" | "result" | "info" | "warn", at: Date.parse("2026-10-28T10:01:00Z") }];
    expect(mergeJournal(rows, chat).map((r) => r.id)).toEqual(["j1", "c1", "j2"]);
  });

  it("the feed is active while files are read, then lingers", () => {
    const files = [
      { id: "a", folderId: null, name: "a", type: "pdf", status: "indexing" },
      { id: "b", folderId: null, name: "b", type: "pdf", status: "ready" },
    ] as FileItem[];
    const events = [ev("1", "read", "2026-10-28T10:00:00Z")];
    const now = Date.parse("2026-10-28T11:00:00Z");
    expect(readingState(events, files, now)).toMatchObject({ active: true, read: 1, total: 2 });
    const done = files.map((f) => ({ ...f, status: "ready" as const }));
    expect(readingState(events, done, now).active).toBe(false);
    expect(readingState(events, done, Date.parse("2026-10-28T10:01:00Z")).active).toBe(true);
  });
});
