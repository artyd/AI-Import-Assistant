import { estimateTransitDays } from './lines.js';
import { greatCircle, pathLengthKm, seaRoute, type LatLng } from './geo.js';

/**
 * Route-builder maths (pure — unit-tested in __tests__/plan.spec.ts).
 *
 * For each leg: geometry by mode, distance, planned window (explicit dates or a
 * mode-based estimate chained from the previous leg), the FACT from a bound
 * tracked item (departed / arrived / ETA / geocoded event path), a PROJECTION
 * that cascades delays into later legs, and — for sea legs with free time — the
 * demurrage exposure given when the next leg actually picks the box up.
 */

export type RouteMode = 'sea' | 'air' | 'road' | 'rail' | 'customs';

export interface LegInput {
  id: string;
  seq: number;
  mode: RouteMode;
  from: { code: string; name: string; pos: LatLng | null };
  to: { code: string; name: string; pos: LatLng | null };
  carrier: string;
  via: '' | 'suez' | 'cape';
  trackedId: string | null;
  plannedDeparture: string | null;
  plannedArrival: string | null;
  costAmount: number | null;
  costCurrency: string;
  freeDays: number | null;
  demurragePerDay: number | null;
  notes: string;
}

export interface TrackFact {
  status: string;
  departedAt: string | null;
  arrivedAt: string | null;
  eta: string | null;
  path: LatLng[];
}

const DAY = 86_400_000;
const t = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : null);
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const round1 = (n: number) => Math.round(n * 10) / 10;

export function legGeometry(leg: Pick<LegInput, 'mode' | 'from' | 'to' | 'via'>): LatLng[] {
  const a = leg.from.pos;
  const b = leg.mode === 'customs' ? (leg.to.pos ?? leg.from.pos) : leg.to.pos;
  if (!a || !b) return a ? [a] : [];
  if (leg.mode === 'customs') return [a];
  if (leg.mode === 'sea') return seaRoute(a, b, { avoidRedSea: leg.via === 'cape' });
  if (leg.mode === 'air') return greatCircle(a, b, 36);
  return [a, b];
}

/** Typical door-to-door duration for a leg when no dates are given (days). */
export function estimateLegDays(mode: RouteMode, path: LatLng[]): number {
  const km = path.length > 1 ? pathLengthKm(path) : 0;
  switch (mode) {
    case 'sea': {
      const e = estimateTransitDays(path, 2);
      return Math.round((e.min + e.max) / 2);
    }
    case 'air':
      return round1(2 + km / 8000);
    case 'road':
      return round1(0.5 + km / 550);
    case 'rail':
      return round1(1 + km / 350);
    case 'customs':
      return 1;
  }
}

export type LegState = 'planned' | 'in_progress' | 'done' | 'no_data';

export interface LegComputed {
  id: string;
  path: LatLng[];
  distanceKm: number;
  plannedDeparture: string | null;
  plannedArrival: string | null;
  estimatedDays: number;
  datesEstimated: boolean;
  fact: { state: LegState; departedAt: string | null; arrivedAt: string | null; eta: string | null; path: LatLng[] } | null;
  projectedDeparture: string | null;
  projectedArrival: string | null;
  delayDays: number;
  freeTime: {
    freeDays: number;
    startsAt: string | null;
    endsAt: string | null;
    daysLeft: number | null;
    overDays: number;
    demurrageCost: number;
    currency: string;
  } | null;
}

export interface PlanSummary {
  legs: LegComputed[];
  distanceKm: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  projectedEnd: string | null;
  delayDays: number;
  costs: Record<string, number>;
  demurrage: Record<string, number>;
  health: 'draft' | 'on_track' | 'delayed' | 'at_risk' | 'done';
}

function factFor(leg: LegInput, f: TrackFact | undefined): LegComputed['fact'] {
  if (!leg.trackedId) return null;
  if (!f) return { state: 'no_data', departedAt: null, arrivedAt: null, eta: null, path: [] };
  const done = f.status === 'delivered' || (!!f.arrivedAt && (f.status === 'at_port' || f.status === 'customs' || f.status === 'out_for_delivery'));
  const state: LegState = done ? 'done' : f.departedAt || f.status === 'in_transit' ? 'in_progress' : f.status === 'unknown' ? 'no_data' : 'planned';
  return { state, departedAt: f.departedAt, arrivedAt: f.arrivedAt, eta: f.eta, path: f.path };
}

export function computePlan(legs: LegInput[], facts: Map<string, TrackFact>, now = Date.now()): PlanSummary {
  const sorted = [...legs].sort((a, b) => a.seq - b.seq);
  const out: LegComputed[] = [];
  let prevPlannedArr: number | null = null;
  let prevProjArr: number | null = null;

  for (const leg of sorted) {
    const path = legGeometry(leg);
    const distanceKm = path.length > 1 ? Math.round(pathLengthKm(path)) : 0;
    const est = estimateLegDays(leg.mode, path);
    let pDep: number | null = t(leg.plannedDeparture) ?? prevPlannedArr;
    let pArr: number | null = t(leg.plannedArrival);
    const datesEstimated = !leg.plannedDeparture || !leg.plannedArrival;
    if (pArr == null && pDep != null) pArr = pDep + est * DAY;
    if (pDep == null && pArr != null) pDep = pArr - est * DAY;
    const plannedDur = pDep != null && pArr != null ? pArr - pDep : est * DAY;

    const fact = factFor(leg, leg.trackedId ? facts.get(leg.trackedId) : undefined);
    const factDep = t(fact?.departedAt);
    const factArr = fact?.state === 'done' ? t(fact.arrivedAt) : null;
    const projDep: number | null = factDep ?? (pDep != null || prevProjArr != null ? Math.max(pDep ?? 0, prevProjArr ?? 0) : null);
    const projArr: number | null = factArr ?? t(fact?.eta) ?? (projDep != null ? projDep + plannedDur : null);
    const delayDays = projArr != null && pArr != null ? round1((projArr - pArr) / DAY) : 0;

    out.push({
      id: leg.id,
      path,
      distanceKm,
      plannedDeparture: iso(pDep),
      plannedArrival: iso(pArr),
      estimatedDays: est,
      datesEstimated,
      fact,
      projectedDeparture: iso(projDep),
      projectedArrival: iso(projArr),
      delayDays,
      freeTime: null,
    });
    prevPlannedArr = pArr;
    prevProjArr = projArr;
  }

  // Free time / demurrage on sea legs: the clock starts at (actual or projected)
  // discharge and stops when the next leg picks the box up.
  const demurrage: Record<string, number> = {};
  sorted.forEach((leg, i) => {
    if (leg.mode !== 'sea' || leg.freeDays == null) return;
    const cur = out[i]!;
    const start = t(cur.fact?.state === 'done' ? cur.fact.arrivedAt : null) ?? t(cur.projectedArrival);
    const end = start != null ? start + leg.freeDays * DAY : null;
    const next = out[i + 1];
    const nextFactDep = t(next?.fact?.departedAt);
    const pickup = nextFactDep ?? t(next?.projectedDeparture);
    const over = end != null && pickup != null ? Math.max(0, Math.ceil((pickup - end) / DAY)) : 0;
    const rate = leg.demurragePerDay ?? 0;
    const cost = over * rate;
    const currency = leg.costCurrency || 'USD';
    if (cost > 0) demurrage[currency] = (demurrage[currency] ?? 0) + cost;
    const pickedUp = nextFactDep != null;
    cur.freeTime = {
      freeDays: leg.freeDays,
      startsAt: iso(start),
      endsAt: iso(end),
      daysLeft: end != null && !pickedUp && cur.fact?.state === 'done' ? round1((end - now) / DAY) : null,
      overDays: over,
      demurrageCost: cost,
      currency,
    };
  });

  const costs: Record<string, number> = {};
  for (const leg of sorted) {
    if (leg.costAmount != null) costs[leg.costCurrency || 'USD'] = (costs[leg.costCurrency || 'USD'] ?? 0) + leg.costAmount;
  }
  const first = out[0];
  const last = out[out.length - 1];
  const delayDays = last?.delayDays ?? 0;
  const allDone = out.length > 0 && out.every((l) => l.fact?.state === 'done');
  const anyFact = out.some((l) => l.fact);
  const health: PlanSummary['health'] = allDone
    ? 'done'
    : Object.keys(demurrage).length > 0 || delayDays >= 3
      ? 'at_risk'
      : delayDays >= 1
        ? 'delayed'
        : anyFact
          ? 'on_track'
          : 'draft';

  return {
    legs: out,
    distanceKm: out.reduce((s, l) => s + l.distanceKm, 0),
    plannedStart: first?.plannedDeparture ?? null,
    plannedEnd: last?.plannedArrival ?? null,
    projectedEnd: last?.projectedArrival ?? null,
    delayDays,
    costs,
    demurrage,
    health,
  };
}

