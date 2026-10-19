import { describe, expect, it } from "vitest";
import type { FileItem } from "@/lib/types";
import { applyFileStatus, docsStatusOf, mapLimit, replayOnSnapshot, restored, withUploaded } from "../fileList";
import { acceptFiles, isAccepted, MAX_FILE_BYTES, planUpload, uploadReport } from "../policy";

const f = (id: string, over: Partial<FileItem> = {}): FileItem =>
  ({ id, folderId: null, name: `${id}.pdf`, type: "pdf", status: "ready", errorReason: null, ...over }) as FileItem;

describe("file list", () => {
  it("a live event updates status and folder; deleted removes; unknown named file is added", () => {
    let list = [f("a", { status: "queued" })];
    list = applyFileStatus(list, { fileId: "a", status: "ready", folderId: "F" } as never);
    expect(list[0]).toMatchObject({ status: "ready", folderId: "F" });
    list = applyFileStatus(list, { fileId: "b", status: "queued", name: "b.pdf" } as never);
    expect(list.map((x) => x.id)).toEqual(["a", "b"]);
    list = applyFileStatus(list, { fileId: "a", status: "deleted" } as never);
    expect(list.map((x) => x.id)).toEqual(["b"]);
  });

  it("events that arrived during a refresh win over the older snapshot", () => {
    const snapshot = [f("a", { status: "indexing" })];
    const out = replayOnSnapshot(snapshot, [{ fileId: "a", status: "ready" } as never]);
    expect(out[0]!.status).toBe("ready");
  });

  it("uploaded files are not duplicated when the live channel added them first", () => {
    expect(withUploaded([f("a")], [f("a"), f("b")]).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("an undone delete returns the file to its place without undoing other changes", () => {
    const afterDelete = [f("a"), f("c", { status: "error" })];
    expect(restored(afterDelete, f("b"), 1).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(restored(afterDelete, f("b"), 1)[2]!.status).toBe("error");
    expect(restored([f("b")], f("b"), 0)).toHaveLength(1);
  });

  it("documents meter counts only latest files", () => {
    const s = docsStatusOf([
      f("a"),
      f("b", { status: "queued" }),
      f("c", { status: "error" }),
      f("d", { extractionStatus: "unreadable" } as Partial<FileItem>),
      f("old", { isLatest: false } as Partial<FileItem>),
    ]);
    expect(s).toEqual({ total: 4, ready: 2, inProgress: 1, errors: 1, needsAttention: 1 });
    expect(docsStatusOf([])).toBeNull();
  });

  it("mapLimit keeps order", async () => {
    expect(await mapLimit([3, 1, 2], 2, async (n) => n * 10)).toEqual([30, 10, 20]);
  });
});

describe("upload policy", () => {
  it("accepts archives and office files everywhere, rejects others", () => {
    expect(isAccepted({ name: "a.ZIP" })).toBe(true);
    expect(isAccepted({ name: "a.doc" })).toBe(true);
    expect(isAccepted({ name: "a.exe" })).toBe(false);
  });

  it("a pasted file without an extension gets one from its MIME type", () => {
    const [out] = acceptFiles([new File(["x"], "scan", { type: "image/png" })]);
    expect(out!.name).toBe("scan.png");
  });

  it("batches by count and by bytes; oversize files are skipped", () => {
    const small = Array.from({ length: 45 }, (_, i) => ({ name: `${i}.pdf`, size: 1 }));
    expect(planUpload(small).batches.map((b) => b.length)).toEqual([40, 5]);
    const big = [{ name: "a.pdf", size: 60 * 1024 * 1024 }, { name: "b.pdf", size: 60 * 1024 * 1024 }];
    expect(planUpload(big).batches).toHaveLength(2);
    const huge = { name: "x.pdf", size: MAX_FILE_BYTES + 1 };
    const zip = { name: "x.zip", size: MAX_FILE_BYTES + 1 };
    expect(planUpload([huge, zip])).toEqual({ batches: [[zip]], skipped: [huge] });
  });

  it("report lists failure, rejected and skipped in that order", () => {
    const r = uploadReport("Не вдалося.", [{ name: "a", reason: "dup" }], [{ name: "b", size: 1048576 }]);
    expect(r.split("\n\n")).toEqual(["Не вдалося.", "Відхилено:\n• a — dup", expect.stringContaining("• b — 1.0 МБ")]);
    expect(uploadReport(null, [], [])).toBe("");
  });
});
