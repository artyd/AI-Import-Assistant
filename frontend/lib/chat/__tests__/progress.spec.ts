import { describe, expect, it } from "vitest";
import {
  currentActivity,
  endTrace,
  estimate,
  finishStep,
  formatElapsed,
  formatSeconds,
  median,
  startStep,
  stepLabel,
  type TurnTrace,
} from "../progress";

const t0: TurnTrace = { startedAt: 1000, steps: [] };

describe("turn progress", () => {
  it("labels tools in plain Ukrainian", () => {
    expect(stepLabel("read_file", { path: "INVOICE.pdf" })).toBe("Читаю INVOICE.pdf");
    expect(stepLabel("get_discrepancies", {})).toBe("Звіряю документи між собою");
    expect(stepLabel("search_documents", { query: "нетто" })).toBe("Шукаю в документах: «нетто»");
    expect(stepLabel("something_new", {})).toBe("Працюю: something_new");
  });

  it("tracks steps: parallel calls, results close the oldest open step of that tool", () => {
    let t = startStep(t0, "read_file", { path: "a.pdf" }, 1100);
    t = startStep(t, "read_file", { path: "b.pdf" }, 1100);
    expect(currentActivity(t, false)).toBe("Читаю b.pdf (і ще 1)");
    t = finishStep(t, "read_file", 1500);
    expect(t.steps[0]!.endedAt).toBe(1500);
    expect(t.steps[1]!.endedAt).toBeUndefined();
    t = finishStep(t, "read_file", 1700);
    expect(currentActivity(t, false)).toBe("Аналізую знайдене");
    expect(currentActivity(t, true)).toBe("Пишу відповідь");
    expect(finishStep(t, "get_risks", 1800)).toBe(t); // no open step → unchanged
  });

  it("before any tool it is reading the question; ending freezes open steps", () => {
    expect(currentActivity(t0, false)).toBe("Розбираю питання й план перевірки");
    const open = startStep(t0, "get_checklist", {}, 1200);
    const ended = endTrace(open, 3000);
    expect(ended.endedAt).toBe(3000);
    expect(ended.steps[0]!.endedAt).toBe(3000);
    expect(endTrace(ended, 9999)).toBe(ended);
  });

  it("formats time", () => {
    expect(formatElapsed(75_400)).toBe("1:15");
    expect(formatElapsed(5_000)).toBe("0:05");
    expect(formatSeconds(18)).toBe("18 с");
    expect(formatSeconds(95)).toBe("1 хв 35 с");
    expect(formatSeconds(120)).toBe("2 хв");
  });

  it("estimates from the median of past turns, never below zero", () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([])).toBeNull();
    // Too little history → generic hint, indeterminate bar.
    expect(estimate(5_000, [20_000])).toEqual({ fraction: null, text: "зазвичай 20–60 с", overdue: false });
    const past = [30_000, 40_000, 50_000];
    const early = estimate(12_000, past);
    expect(early.text).toBe("≈ ще 30 с");
    expect(early.fraction).toBeCloseTo(0.3);
    const late = estimate(70_000, past);
    expect(late.overdue).toBe(true);
    expect(late.text).toMatch(/довше, ніж зазвичай/);
  });
});
