import { describe, expect, it } from "vitest";
import {
  completeActiveStep,
  deadline,
  deadlineLabel,
  eventsByDay,
  kyivToday,
  matches,
  monthGrid,
  normalizeSteps,
  sortShipments,
} from "../logic";
import type { SupplyShipment, SupplyStep } from "../types";

const step = (o: Partial<SupplyStep>): SupplyStep => ({ id: "s", name: "Етап", plan: "", actual: "", state: "pending", note: "", ...o });
const ship = (o: Partial<SupplyShipment>): SupplyShipment => ({
  id: "a", name: "Товар", category: "Міжнародні", action: "", note: "", archived: false, steps: [], custom: {}, position: 0,
  createdAt: "", updatedAt: "2026-11-01T00:00:00.000Z", ...o,
});
const TODAY = "2026-11-05";

describe("deadlines", () => {
  it("labels overdue, today, soon, none", () => {
    const at = (plan: string) => deadlineLabel(deadline({ steps: [step({ state: "active", plan })] }, TODAY));
    expect(at("2026-11-02")).toBe("−3 дн.");
    expect(at("2026-11-05")).toBe("сьогодні");
    expect(at("2026-11-06")).toBe("завтра");
    expect(at("2026-11-11")).toBe("через 6 дн.");
    expect(at("")).toBe("без дати");
  });
});

describe("sorting and search", () => {
  it("by date puts overdue first and undated last", () => {
    const list = [
      ship({ id: "none" }),
      ship({ id: "late", steps: [step({ state: "active", plan: "2026-11-01" })] }),
      ship({ id: "next", steps: [step({ state: "active", plan: "2026-11-09" })] }),
    ];
    expect(sortShipments(list, "date", TODAY).map((s) => s.id)).toEqual(["late", "next", "none"]);
  });

  it("search looks into steps and extra fields", () => {
    const s = ship({ steps: [step({ name: "Ветеринарний контроль" })], custom: { supplier: "Макрохим" } });
    expect(matches(s, "ветеринар")).toBe(true);
    expect(matches(s, "макрохим")).toBe(true);
    expect(matches(s, "порт")).toBe(false);
  });
});

describe("steps", () => {
  it("completing the active step stamps today and activates the next", () => {
    const out = completeActiveStep([step({ id: "1", state: "active" }), step({ id: "2" })], TODAY);
    expect(out[0]).toMatchObject({ state: "done", actual: TODAY });
    expect(out[1]?.state).toBe("active");
  });

  it("normalize keeps one active step: the first open one", () => {
    const out = normalizeSteps([step({ id: "1", state: "done" }), step({ id: "2", state: "pending" }), step({ id: "3", state: "active" })]);
    expect(out.map((s) => s.state)).toEqual(["done", "active", "pending"]);
  });
});

describe("calendar", () => {
  it("a month is 42 days starting on Monday", () => {
    const g = monthGrid(2026, 10);
    expect(g).toHaveLength(42);
    expect(g[0]).toBe("2026-10-26");
    expect(g).toContain("2026-11-30");
  });

  it("events sit on the fact date, else the plan, and missed plans are overdue", () => {
    const ev = eventsByDay([ship({ steps: [step({ state: "done", plan: "2026-11-01", actual: "2026-11-02" }), step({ state: "active", plan: "2026-11-03" })] })], TODAY);
    expect(ev.get("2026-11-02")?.[0]?.tone).toBe("done");
    expect(ev.get("2026-11-03")?.[0]?.tone).toBe("overdue");
  });

  it("today is a Kyiv calendar day", () => {
    expect(kyivToday(new Date("2026-11-04T22:30:00Z"))).toBe("2026-11-05");
  });
});
