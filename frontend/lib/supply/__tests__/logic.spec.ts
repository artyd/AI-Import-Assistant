import { describe, expect, it } from "vitest";
import {
  categoryIcon,
  completeActiveStep,
  deadline,
  deadlineLabel,
  eventsByDay,
  kyivToday,
  matches,
  monthGrid,
  normalizeSteps,
  sortShipments,
  transportMode,
} from "../logic";
import type { SupplyShipment, SupplyStep } from "../types";

const step = (o: Partial<SupplyStep>): SupplyStep => ({ id: "s", name: "Етап", plan: "", actual: "", state: "pending", note: "", ...o });
const ship = (o: Partial<SupplyShipment>): SupplyShipment => ({
  id: "a", name: "Товар", category: "Міжнародні", action: "", note: "", archived: false, steps: [], custom: {}, pinned: false, groups: [], mode: "", position: 0,
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

describe("marks", () => {
  it("starred shipments stay on top whatever the sort", () => {
    const list = [
      ship({ id: "a", name: "Альфа", steps: [step({ state: "active", plan: "2026-11-06" })] }),
      ship({ id: "z", name: "Зета", pinned: true }),
    ];
    for (const key of ["date", "name", "updated"] as const) expect(sortShipments(list, key, TODAY)[0]!.id).toBe("z");
  });

  it("category icon: set in Довідники, else guessed from the name", () => {
    expect(categoryIcon({ categoryIcons: {} }, "Міжнародні")).toBe("globe");
    expect(categoryIcon({ categoryIcons: {} }, "Україна")).toBe("ukraine");
    expect(categoryIcon({ categoryIcons: {} }, "Зразки")).toBe("sample");
    expect(categoryIcon({ categoryIcons: {} }, "Інше")).toBe("tag");
    expect(categoryIcon({ categoryIcons: { "Зразки": "box" } }, "Зразки")).toBe("box");
    expect(categoryIcon({ categoryIcons: { "Зразки": "nope" } }, "Зразки")).toBe("sample");
  });

  it("transport: set by hand, else read from the stages, else unknown", () => {
    const by = (...names: string[]) => transportMode({ mode: "", steps: names.map((name) => step({ name })) });
    expect(by("Готовність", "Виліт", "Прибуття")).toBe("air");
    expect(by("Відправка", "Прибуття в порт", "Вивіз з порту")).toBe("sea");
    expect(by("Відправка залізницею")).toBe("rail");
    expect(by("Завантаження", "Доставка")).toBe("road");
    expect(by("Готовність")).toBeNull();
    expect(transportMode({ mode: "courier", steps: [step({ name: "Виліт" })] })).toBe("courier");
  });
});
