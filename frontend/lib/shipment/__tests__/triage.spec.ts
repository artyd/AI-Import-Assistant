import { afterEach, describe, expect, it, vi } from "vitest";
import type { Discrepancy, FclOverview } from "@/lib/types";
import { groupFindings, statusCaveat, summarizeFindings } from "../findings";
import { lotLight, lotRows, fclCounts } from "@/lib/fcl/fcl";
import { askPrompts } from "@/lib/chat/askBus";
import { REASON_LABEL, decideFinding, decisionText, undoFinding, validateTriage } from "../triage";

const triaged = { status: "not_problem" as const, reason: "legs", note: "", user_name: "А", decided_at: "2026-11-13T10:00:00Z" };
const d = (over: Partial<Discrepancy & { lot?: string }> = {}) => ({
  field: "net_weight_kg",
  expected: "1",
  actual: "2",
  severity: "error" as const,
  kind: "confirmed" as const,
  ...over,
});

describe("validateTriage", () => {
  it("not_problem needs a reason", () => {
    expect(validateTriage({ status: "not_problem" })).toBe("Оберіть причину.");
    expect(validateTriage({ status: "not_problem", reason: "legs" })).toBeNull();
  });
  it("other needs a note", () => {
    expect(validateTriage({ status: "not_problem", reason: "other", note: "  " })).not.toBeNull();
    expect(validateTriage({ status: "not_problem", reason: "other", note: "бо так" })).toBeNull();
  });
  it("resolved needs nothing; a huge note is refused", () => {
    expect(validateTriage({ status: "resolved" })).toBeNull();
    expect(validateTriage({ status: "resolved", note: "x".repeat(1001) })).not.toBeNull();
  });
  it("labels match the spec", () => {
    expect(REASON_LABEL.legs).toBe("Різні плечі угоди");
    expect(REASON_LABEL.agreed).toBe("Погоджено з брокером / митницею");
  });
});

describe("decisionText", () => {
  it("reads reason and note", () => {
    expect(decisionText({ status: "not_problem", reason: "legs", note: "ок" })).toBe("Не проблема: Різні плечі угоди — ок");
    expect(decisionText({ status: "resolved", reason: null, note: "" })).toBe("Вирішено");
    expect(decisionText({ status: "resolved", reason: null, note: "лист" })).toBe("Вирішено — лист");
  });
});

describe("triage client", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (status: number, body: unknown) => {
    const fn = vi.fn(async (..._a: unknown[]) => ({ ok: status < 400, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) }));
    vi.stubGlobal("fetch", fn);
    return fn;
  };

  it("PUTs the decision with lot and title", async () => {
    const fn = stub(200, { triage: triaged });
    const t = await decideFinding("w1", "ab/c", { status: "not_problem", reason: "legs", note: " n ", title: "Вага", lot: "L1" });
    expect(t.status).toBe("not_problem");
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/workspaces/w1/findings/ab%2Fc/triage");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ status: "not_problem", reason: "legs", note: "n", title: "Вага", lot: "L1" });
  });
  it("refuses an invalid decision without a request", async () => {
    const fn = stub(200, {});
    await expect(decideFinding("w1", "f", { status: "not_problem", title: "t" })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
  it("DELETEs to undo", async () => {
    const fn = stub(204, undefined);
    await undoFinding("w1", "fp");
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/workspaces/w1/findings/fp/triage");
    expect(init.method).toBe("DELETE");
  });
});

describe("counting ignores triaged findings", () => {
  const items = [d(), d({ severity: "warning" }), d({ kind: "suspected" }), d({ triage: triaged }), d({ kind: "suspected", triage: triaged }), d({ severity: "info", triage: triaged })];
  it("summarizeFindings", () => {
    const s = summarizeFindings(items);
    expect(s).toMatchObject({ errors: 1, warnings: 1, toCheck: 1, notes: 0, decided: 3, problems: 3 });
  });
  it("only triaged errors → green", () => {
    expect(summarizeFindings([d({ triage: triaged })]).tone).toBe("ok");
  });
  it("groupFindings puts them in decided", () => {
    const g = groupFindings(items);
    expect(g.decided).toHaveLength(3);
    expect(g.problems).toHaveLength(2);
    expect(g.check).toHaveLength(1);
  });
  it("statusCaveat is silent when the only error is triaged", () => {
    expect(statusCaveat("customs_ready", summarizeFindings([d({ triage: triaged })]))).toBeNull();
    expect(statusCaveat("customs_ready", summarizeFindings([d()]))).not.toBeNull();
  });
  it("lotLight and lotRows go green", () => {
    const lotFor = (n: string) => ({
      id: n,
      name: n,
      consignee: null,
      completeness: { done: 2, total: 2 },
      risks: { error: 0, warning: 0 },
    });
    const o = {
      lots: [lotFor("L1")],
      all_discrepancies: [d({ lot: "L1", triage: triaged })],
    } as unknown as Pick<FclOverview, "lots" | "all_discrepancies">;
    expect(lotRows(o)[0]).toMatchObject({ light: "ok", summary: "без проблем" });
    expect(lotLight(lotFor("L1"), summarizeFindings(o.all_discrepancies))).toBe("ok");
  });
  it("fclCounts skips triaged risks and findings", () => {
    const c = fclCounts({
      risks: [{ code: "a", category: "discrepancy", severity: "error", title: "t", detail: "", source_file_id: null, triage: triaged }],
      all_discrepancies: [d({ triage: triaged }), d({ lot: "L1", triage: triaged })],
    } as unknown as Pick<FclOverview, "risks" | "all_discrepancies">);
    expect(c.risksError).toBe(0);
    expect(c.all.problems).toBe(0);
    expect(c.lots.decided).toBe(1);
  });
});

describe("askPrompts for triage", () => {
  it("solve", () => {
    expect(askPrompts.solve({ title: "Вага нетто", values: "1 → 2", files: "«a.pdf»", lot: "L1" })).toBe(
      "Як вирішити: Вага нетто (1 → 2, «a.pdf», партія «L1»)? Дай конкретні кроки; якщо має діяти постачальник — текст листа українською та англійською.",
    );
    expect(askPrompts.solve({ title: "Ризик" })).toBe(
      "Як вирішити: Ризик? Дай конкретні кроки; якщо має діяти постачальник — текст листа українською та англійською.",
    );
  });
  it("request", () => {
    expect(askPrompts.request("Інвойс", { kind: "shipment" })).toBe(
      "Склади лист-запит постачальнику на «Інвойс» (українською та англійською): що надіслати і навіщо.",
    );
    expect(askPrompts.request("Інвойс", { kind: "lot", name: "L1" })).toContain("партія «L1»");
  });
});
