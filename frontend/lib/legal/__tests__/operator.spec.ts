import { describe, expect, it } from "vitest";
import { OPERATOR, hasPlaceholders, isPlaceholder, placeholderFields } from "../operator";

describe("legal operator details", () => {
  it("recognises placeholders", () => {
    expect(isPlaceholder("[Назва]")).toBe(true);
    expect(isPlaceholder("ТОВ «Приклад»")).toBe(false);
  });

  it("lists the fields that are still placeholders", () => {
    const left = placeholderFields();
    console.log(
      left.length
        ? `operator.ts: ${left.length} placeholder(s) left: ${left.join(", ")}`
        : "operator.ts: all fields are filled"
    );
    expect(hasPlaceholders()).toBe(left.length > 0);
    for (const k of Object.keys(OPERATOR)) expect(OPERATOR[k as keyof typeof OPERATOR].length).toBeGreaterThan(0);
  });
});
