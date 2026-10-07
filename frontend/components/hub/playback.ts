// "Програти рейс": rebuild where a cargo was on each day from its carrier
// events, next to where the plan (departure → first ETA) said it should be.

import type { LatLng, Track, TrackEvent } from "@/lib/hub";
import { progressOnPath, smoothPath, splitAt } from "./geo";

export const DAY = 86_400_000;

export interface Replay {
  trackId: string;
  path: LatLng[];
  frames: { t: number; p: number }[];
  start: number;
  end: number;
  planStart: number | null;
  planEnd: number | null;
  events: { t: number; label: string; location: string }[];
}

export function buildReplay(track: Track, events: TrackEvent[], now = Date.now()): Replay | null {
  const path = smoothPath(track.live?.path ?? []);
  if (path.length < 2) return null;
  const past = events
    .filter((e) => !e.planned && e.at)
    .map((e) => ({ ...e, ms: new Date(e.at!).getTime() }))
    .sort((a, b) => a.ms - b.ms);
  const frames: { t: number; p: number }[] = [];
  const dep = track.departedAt ? new Date(track.departedAt).getTime() : past[0]?.ms;
  if (dep == null) return null;
  frames.push({ t: dep, p: 0 });
  let last = 0;
  for (const e of past) {
    if (e.lat == null || e.lng == null || e.ms < dep) continue;
    last = Math.max(last, progressOnPath(path, [e.lat, e.lng]));
    frames.push({ t: e.ms, p: last });
  }
  if (track.status === "delivered" && track.arrivedAt) {
    frames.push({ t: Math.max(new Date(track.arrivedAt).getTime(), frames[frames.length - 1]!.t), p: 1 });
  } else {
    frames.push({ t: Math.max(now, frames[frames.length - 1]!.t), p: Math.max(last, track.live?.progress ?? last) });
  }
  const planEndIso = track.firstEta ?? track.eta;
  return {
    trackId: track.id,
    path,
    frames,
    start: frames[0]!.t,
    end: frames[frames.length - 1]!.t,
    planStart: dep,
    planEnd: planEndIso ? new Date(planEndIso).getTime() : null,
    events: past.map((e) => ({ t: e.ms, label: e.description, location: e.location })),
  };
}

/** Actual progress at time t (piecewise linear between keyframes). */
export function actualProgress(r: Replay, t: number): number {
  const f = r.frames;
  if (t <= f[0]!.t) return f[0]!.p;
  for (let i = 1; i < f.length; i += 1) {
    const a = f[i - 1]!;
    const b = f[i]!;
    if (t <= b.t) return b.t === a.t ? b.p : a.p + ((b.p - a.p) * (t - a.t)) / (b.t - a.t);
  }
  return f[f.length - 1]!.p;
}

export function planProgress(r: Replay, t: number): number | null {
  if (r.planStart == null || r.planEnd == null || r.planEnd <= r.planStart) return null;
  return Math.max(0, Math.min(1, (t - r.planStart) / (r.planEnd - r.planStart)));
}

/** Days behind (+) / ahead (−) of plan at time t. */
export function lagDays(r: Replay, t: number): number | null {
  if (r.planStart == null || r.planEnd == null || r.planEnd <= r.planStart) return null;
  const p = actualProgress(r, t);
  const tPlan = r.planStart + p * (r.planEnd - r.planStart);
  return Math.round(((t - tPlan) / DAY) * 10) / 10;
}

export function positionAt(r: Replay, p: number): { point: LatLng; heading: number; done: LatLng[] } {
  const s = splitAt(r.path, p);
  return { point: s.point, heading: s.heading, done: s.done };
}

export function lastEventAt(r: Replay, t: number) {
  let e: Replay["events"][number] | undefined;
  for (const x of r.events) if (x.t <= t) e = x;
  return e;
}
