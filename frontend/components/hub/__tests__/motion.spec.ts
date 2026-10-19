import { describe, expect, it } from "vitest";
import type { Track } from "@/lib/hub";
import { deadReckon, estimatePosition, glidePosition } from "../motion";
import { haversineKm } from "../geo";

const DAY = 86_400_000;

describe("hub motion", () => {
  it("glide eases out from start to end and stops once arrived", () => {
    const from: [number, number] = [0, 0];
    const to: [number, number] = [10, 0];
    expect(glidePosition(from, to, 0, 0, 1000)).toEqual([0, 0]);
    const mid = glidePosition(from, to, 0, 500, 1000)!;
    expect(mid[0]).toBeCloseTo(8.75); // 1 - 0.5³ = 0.875
    expect(glidePosition(from, to, 0, 1000, 1000)).toBeNull();
  });

  const track = (over: Record<string, unknown> = {}) =>
    ({
      mode: "sea",
      status: "in_transit",
      departedAt: new Date(0).toISOString(),
      eta: new Date(10 * DAY).toISOString(),
      live: { positionSource: "estimate", path: [[0, 0], [0, 10]], pos: [0, 0], progress: 0 },
      ...over,
    }) as unknown as Track;

  it("an estimate creeps along the lane with the share of the trip elapsed", () => {
    const half = estimatePosition(track(), 5 * DAY)!;
    expect(half.point[1]).toBeGreaterThan(4);
    expect(half.point[1]).toBeLessThan(6);
  });

  it("the estimate never claims arrival or not having left (2–97 %)", () => {
    const before = estimatePosition(track(), -DAY)!.point;
    const after = estimatePosition(track(), 20 * DAY)!.point;
    expect(before[1]).toBeGreaterThan(0);
    expect(after[1]).toBeLessThan(10);
  });

  it("no estimate without one, or with an ETA before departure", () => {
    expect(estimatePosition(track({ live: { positionSource: "ais", path: [[0, 0], [0, 1]] } }), DAY)).toBeNull();
    expect(estimatePosition(track({ eta: new Date(-DAY).toISOString() }), DAY)).toBeNull();
  });

  it("dead reckoning drifts by speed and course, capped in time", () => {
    const v = { sog: 10, cog: 90 }; // 10 kn east
    const hour = deadReckon([0, 0], 0, v, 3_600_000, 20 * 60_000)!;
    expect(haversineKm([0, 0], hour)).toBeCloseTo((10 * 1.852 * 20) / 60, 1); // capped at 20 min
    expect(deadReckon([0, 0], 0, { sog: 0.2, cog: 90 }, 3_600_000, 1e9)).toBeNull();
    expect(deadReckon([0, 0], 0, { sog: null, cog: 90 }, 1, 1)).toBeNull();
  });
});
