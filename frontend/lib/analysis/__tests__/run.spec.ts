import { describe, expect, it, vi } from "vitest";

let script: (h: { onDone?: (d: unknown) => void; onError?: (m: string) => void }) => Promise<void> = async () => {};
vi.mock("@/lib/sse", () => ({ streamAnalyze: (_p: string, _b: unknown, h: never) => script(h) }));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { analyzeBody, runAnalysis } = await import("../run");
const { newestConversation } = await import("@/lib/chatContext");

const signal = () => new AbortController().signal;

describe("consolidated analysis run", () => {
  it("a link becomes sheetUrl, anything else a pasted table; the conversation rides along", () => {
    expect(analyzeBody({ input: " https://docs.google.com/x " })).toEqual({ sheetUrl: "https://docs.google.com/x" });
    expect(analyzeBody({ input: "a\tb" }, "c1")).toEqual({ text: "a\tb", conversationId: "c1" });
    const form = analyzeBody({ file: new File(["x"], "m.xlsx") }, "c1") as FormData;
    expect([...form.keys()]).toEqual(["conversationId", "files"]);
  });

  it("done, server error, a stream that ends without a result, and a network failure", async () => {
    script = async (h) => h.onDone?.({ analysis: { id: "a" } });
    expect((await runAnalysis("c", {}, () => {}, signal())).kind).toBe("done");
    script = async (h) => h.onError?.("");
    expect(await runAnalysis("c", {}, () => {}, signal())).toEqual({ kind: "error", message: "Не вдалося виконати аналіз." });
    script = async () => {};
    expect(await runAnalysis("c", {}, () => {}, signal())).toEqual({ kind: "error", message: "Аналіз перервано. Спробуйте ще раз." });
    script = async () => {
      throw new Error("net");
    };
    expect((await runAnalysis("c", {}, () => {}, signal())).kind).toBe("error");
    const ctrl = new AbortController();
    ctrl.abort();
    expect((await runAnalysis("c", {}, () => {}, ctrl.signal)).kind).toBe("aborted");
  });
});

describe("conversations", () => {
  it("newest by updated_at", () => {
    const list = [
      { id: "a", updated_at: "2026-10-01" },
      { id: "b", updated_at: "2026-10-05" },
    ] as never;
    expect(newestConversation(list)?.id).toBe("b");
    expect(newestConversation([])).toBeNull();
  });
});
