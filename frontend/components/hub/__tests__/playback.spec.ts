import { describe, expect, it } from "vitest";
import type { Track, TrackEvent } from "@/lib/hub";
import { actualProgress, buildReplay, lagDays, planProgress } from "../playback";

const DAY = 86_400_000;
const iso = (d: number) => new Date(d * DAY).toISOString();

const track = (over: Record<string, unknown> = {}) =>
  ({
    id: "t1",
    status: "in_transit",
    departedAt: iso(0),
    eta: iso(10),
    firstEta: iso(8),
    live: { path: [[0, 0], [0, 10]], progress: 0.5 },
    ...over,
  }) as unknown as Track;

const ev = (d: number, lng: number, over: Record<string, unknown> = {}) =>
  ({ at: iso(d), lat: 0, lng, planned: false, description: "e", location: "L", ...over }) as unknown as TrackEvent;

describe("voyage replay", () => {
  it("needs a path and a departure", () => {
    expect(buildReplay(track({ live: { path: [[0, 0]] } }), [], 0)).toBeNull();
    expect(buildReplay(track({ departedAt: null }), [], 0)).toBeNull();
  });

  it("actual progress follows the events and never goes back", () => {
    const r = buildReplay(track(), [ev(2, 3), ev(4, 2), ev(6, 6), ev(5, 9, { planned: true })], 7 * DAY)!;
    const ps = r.frames.map((f) => f.p);
    expect(ps).toEqual([...ps].sort((a, b) => a - b));
    expect(actualProgress(r, -DAY)).toBe(0);
    expect(actualProgress(r, 3 * DAY)).toBeGreaterThan(0);
  });

  it("delivered ends at 100 % on the arrival time", () => {
    const r = buildReplay(track({ status: "delivered", arrivedAt: iso(9) }), [], 20 * DAY)!;
    expect(r.frames.at(-1)).toEqual({ t: 9 * DAY, p: 1 });
  });

  it("the plan runs from departure to the FIRST eta; lag is in days", () => {
    const r = buildReplay(track(), [], 4 * DAY)!;
    expect(planProgress(r, 4 * DAY)).toBeCloseTo(0.5);
    expect(lagDays(r, 4 * DAY)).not.toBeNull();
    expect(planProgress(buildReplay(track({ firstEta: null, eta: null }), [], 0)!, 0)).toBeNull();
  });
});
