import { describe, expect, it } from "vitest";
import { colorToAlpha, trimBox } from "../stampImage";

const px = (...rgba: number[]) => new Uint8ClampedArray(rgba);

describe("colorToAlpha", () => {
  it("makes white paper transparent and keeps the ink", () => {
    const d = px(255, 255, 255, 255, 250, 252, 251, 255, 0, 0, 255, 255);
    colorToAlpha(d);
    expect(d[3]).toBe(0); // white
    expect(d[7]).toBe(0); // near-white JPEG noise
    expect([...d.slice(8)]).toEqual([0, 0, 255, 255]); // pure blue ink stays opaque
  });

  it("turns light ink into a semi-transparent stroke of the same colour", () => {
    const d = px(128, 128, 255, 255);
    colorToAlpha(d);
    expect(d[3]).toBe(127);
    expect(d[0]).toBe(0); // dark ink at half strength composes back to ≈128 over white
    expect(d[2]).toBe(255);
  });

  it("respects the picture's own transparency", () => {
    const d = px(0, 0, 0, 100);
    colorToAlpha(d);
    expect(d[3]).toBe(100);
  });
});

describe("trimBox", () => {
  it("finds the visible part", () => {
    // 3×2: only the pixel at (1,1) is visible
    const d = new Uint8ClampedArray(3 * 2 * 4);
    d[(1 * 3 + 1) * 4 + 3] = 255;
    expect(trimBox(d, 3, 2)).toEqual({ x: 1, y: 1, w: 1, h: 1 });
  });
  it("returns null for an empty picture", () => {
    expect(trimBox(new Uint8ClampedArray(16), 2, 2)).toBeNull();
  });
});
