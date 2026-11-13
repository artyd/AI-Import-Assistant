import { describe, expect, it } from "vitest";
import type { Discrepancy } from "@/lib/types";
import { fclCounts, lotFindings, lotLight, resolveScope, unassignedLabel } from "../fcl";

const lot = (over: Partial<Parameters<typeof lotLight>[0]> = {}) => ({
  completeness: { done: 5, total: 5 },
  risks: { error: 0, warning: 0 },
  ...over,
});
const f = (over: Partial<Parameters<typeof lotLight>[1]> = {}) => ({ errors: 0, warnings: 0, toCheck: 0, ...over });
const d = (over: Partial<Discrepancy & { lot?: string }> = {}) => ({
  field: "net_weight_kg",
  expected: "1",
  actual: "2",
  severity: "error" as const,
  kind: "confirmed" as const,
  ...over,
});

describe("lotLight", () => {
  it("green when complete and clean", () => expect(lotLight(lot(), f())).toBe("ok"));
  it("yellow on a missing document, a warning or a suspicion", () => {
    expect(lotLight(lot({ completeness: { done: 3, total: 5 } }), f())).toBe("warn");
    expect(lotLight(lot(), f({ toCheck: 1 }))).toBe("warn");
    expect(lotLight(lot(), f({ warnings: 1 }))).toBe("warn");
  });
  it("red only on a confirmed error or a critical risk", () => {
    expect(lotLight(lot(), f({ errors: 1 }))).toBe("err");
    expect(lotLight(lot({ risks: { error: 1, warning: 0 } }), f())).toBe("err");
  });
});

describe("lotFindings", () => {
  it("counts a lot's own findings; info notes do not colour it", () => {
    const all = [
      d({ lot: "Alpha", severity: "info" }),
      d({ lot: "Alpha", severity: "info" }),
      d({ lot: "Beta", severity: "warning", kind: "suspected" }),
      d(),
    ];
    const alpha = lotFindings("Alpha", all);
    expect(alpha).toMatchObject({ errors: 0, notes: 2, problems: 0, tone: "ok" });
    expect(lotLight(lot(), alpha)).toBe("ok");
    expect(lotFindings("Beta", all)).toMatchObject({ toCheck: 1, tone: "warn" });
  });
});

describe("helpers", () => {
  it("counts FCL risks and discrepancies", () => {
    expect(
      fclCounts({
        risks: [
          { code: "a", category: "expiry", severity: "error", title: "", detail: "", source_file_id: null },
          { code: "b", category: "expiry", severity: "warning", title: "", detail: "", source_file_id: null },
        ],
        all_discrepancies: [{ field: "x", expected: "", actual: "", severity: "error", kind: "confirmed" }],
      }),
    ).toMatchObject({ risksError: 1, risksWarning: 1, risksNotes: 0, level: { errors: 1 }, lots: { problems: 0 } });
  });

  it("keeps FCL-level and lot-level findings apart and never counts info as a problem", () => {
    const c = fclCounts({
      risks: [{ code: "n", category: "discrepancy", severity: "info", title: "", detail: "", source_file_id: null }],
      all_discrepancies: [d({ severity: "info" }), d({ lot: "Alpha", severity: "info" }), d({ lot: "Alpha", severity: "warning", kind: "suspected" })],
    });
    expect(c.level).toMatchObject({ notes: 1, problems: 0 });
    expect(c.lots).toMatchObject({ notes: 1, toCheck: 1, problems: 1 });
    expect(c.risksError + c.risksWarning).toBe(0);
    expect(c.risksNotes).toBe(1);
  });

  it("falls back to the FCL scope when the lot is gone", () => {
    expect(resolveScope("L1", [{ id: "L1" }])).toBe("L1");
    expect(resolveScope("L9", [{ id: "L1" }])).toBe("fcl");
  });

  it("pluralises the unassigned hint", () => {
    expect(unassignedLabel(0)).toBeNull();
    expect(unassignedLabel(1)).toBe("Без партії: 1 файл");
    expect(unassignedLabel(3)).toBe("Без партії: 3 файли");
    expect(unassignedLabel(12)).toBe("Без партії: 12 файлів");
  });
});

describe("lotRows — the sidebar's lot list", () => {
  it("worst lot first; notes do not count; docs as done/total", async () => {
    const { lotRows } = await import("../fcl");
    const lot = (id: string, name: string, done: number, total: number, risks = { error: 0, warning: 0 }) => ({
      id, name, supplier_name: name, source: "auto" as const, status: "draft" as const, derived_status: "draft" as const,
      file_count: 3, consignee: "NOVALAIT", intake_complete: true, completeness: { done, total },
      discrepancies: { confirmed: 0, suspected: 0 }, risks, context: {} as never,
    });
    const d = (lotName: string, severity: "error" | "warning" | "info", kind: "confirmed" | "suspected" = "confirmed") =>
      ({ field: "net_weight_kg", expected: "1", actual: "2", severity, kind, citations: [], lot: lotName }) as never;
    const rows = lotRows({
      lots: [lot("a", "Alpha", 5, 5), lot("b", "Beta", 4, 5), lot("c", "Gamma", 6, 6)],
      all_discrepancies: [d("Alpha", "info"), d("Gamma", "error"), d("Beta", "warning", "suspected")],
    });
    expect(rows.map((r) => `${r.name}:${r.light}:${r.docs}:${r.summary}`)).toEqual([
      "Gamma:err:6/6:1 проблема",
      "Beta:warn:4/5:1 перевірити",
      "Alpha:ok:5/5:без проблем",
    ]);
  });
});
