import { describe, expect, it } from "vitest";
import { fclCounts, lotLight, resolveScope, unassignedLabel } from "../fcl";

const lot = (over: Partial<Parameters<typeof lotLight>[0]> = {}) => ({
  completeness: { done: 5, total: 5 },
  discrepancies: { confirmed: 0, suspected: 0 },
  risks: { error: 0, warning: 0 },
  ...over,
});

describe("lotLight", () => {
  it("green when complete and clean", () => expect(lotLight(lot())).toBe("ok"));
  it("yellow on a missing document or a suspicion", () => {
    expect(lotLight(lot({ completeness: { done: 3, total: 5 } }))).toBe("warn");
    expect(lotLight(lot({ discrepancies: { confirmed: 0, suspected: 1 } }))).toBe("warn");
  });
  it("red on a confirmed discrepancy or a critical risk", () => {
    expect(lotLight(lot({ discrepancies: { confirmed: 1, suspected: 0 } }))).toBe("err");
    expect(lotLight(lot({ risks: { error: 1, warning: 0 } }))).toBe("err");
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
    ).toEqual({ risksError: 1, risksWarning: 1, confirmed: 1, suspected: 0 });
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
