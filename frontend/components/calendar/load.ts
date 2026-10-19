"use client";
import { type CalRow, type CalEvent, fmtDay, uaHoliday, EVENT_META } from "@/lib/calendar";

// ── Search / load / year tooltip helpers ─────────────────────────────────────

export function matchesQuery(r: CalRow, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return [r.product, r.number ?? "", r.forwarder, r.destination, r.origin, r.carrierName ?? ""].some((x) => x.toLowerCase().includes(t));
}

export interface Load {
  containers: number;
  air: number;
  parcels: number;
  heavy: boolean;
  text: string;
  title: string;
}

/** Day threshold above which a day is highlighted as busy. */
const HEAVY_CONTAINERS = 3;
const HEAVY_TOTAL = 6;

/** What physically arrives that day (planned / actual / tracking ETA), by kind and place. */
export function dayLoad(list: CalEvent[], rowsById: Map<string, CalRow>): Load {
  const seen = new Set<string>();
  let containers = 0;
  let air = 0;
  let parcels = 0;
  const places = new Map<string, number>();
  for (const e of list) {
    if (!["arrival", "arrived", "eta"].includes(e.type) || seen.has(e.rowId)) continue;
    const r = rowsById.get(e.rowId);
    if (!r) continue;
    seen.add(e.rowId);
    if (["fcl", "groupage", "lcl"].includes(r.cargoType)) containers += 1;
    else if (r.cargoType === "air") air += 1;
    else parcels += 1;
    const pl = r.destination || "—";
    places.set(pl, (places.get(pl) ?? 0) + 1);
  }
  const total = containers + air + parcels;
  const text = [containers ? `🚢${containers}` : "", air ? `✈️${air}` : "", parcels ? `📮${parcels}` : ""].filter(Boolean).join(" ");
  const title = total
    ? `Прибуває: ${total} (контейнери ${containers}, авіа ${air}, посилки ${parcels})\n${[...places.entries()].map(([k, v]) => `${k}: ${v}`).join("\n")}`
    : "";
  return { containers, air, parcels, heavy: containers >= HEAVY_CONTAINERS || total >= HEAVY_TOTAL, text, title };
}

export function yearTitle(d: string, list: CalEvent[], rowsById: Map<string, CalRow>): string {
  const head = `${fmtDay(d)}${uaHoliday(d) ? ` · ${uaHoliday(d)}` : ""}`;
  if (!list.length) return head;
  const lines = list.slice(0, 10).map((e) => `${EVENT_META[e.type].icon} ${rowsById.get(e.rowId)?.product ?? ""} — ${EVENT_META[e.type].label}`);
  return [head, ...lines, list.length > 10 ? `… ще ${list.length - 10}` : ""].filter(Boolean).join("\n");
}
