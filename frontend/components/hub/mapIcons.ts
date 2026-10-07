// Leaflet divIcon factories for the logistics hub map. Inline SVG so markers
// inherit colours from CSS tokens and can be rotated by heading. Imported only
// from client components loaded with ssr:false (Leaflet needs `window`).

import L from "leaflet";
import type { HubMode, TrackStatus } from "@/lib/hub";
import { statusColor } from "@/lib/hub";

// Glyphs drawn pointing NORTH so a CSS rotate(heading) aims them correctly.
const SHIP =
  '<path d="M12 1.8 16.6 8.4V19.2c0 .5-.3.9-.8 1.1L12 22l-3.8-1.7c-.5-.2-.8-.6-.8-1.1V8.4Z" fill="currentColor"/>' +
  '<rect x="10" y="9.5" width="4" height="3.2" rx=".6" fill="var(--surface)" opacity=".9"/>' +
  '<rect x="10" y="14" width="4" height="3.2" rx=".6" fill="var(--surface)" opacity=".9"/>';
const PLANE =
  '<path d="M12 1.6c.9 0 1.5.8 1.5 1.7v5.8l7.8 4.6v2.1l-7.8-2.4v4.9l2.2 1.6v1.7L12 21l-3.7 1v-1.7l2.2-1.6v-4.9l-7.8 2.4v-2.1l7.8-4.6V3.3c0-.9.6-1.7 1.5-1.7Z" fill="currentColor"/>';
const TRUCK =
  '<path d="M2.5 6.5h11v9h-11z" fill="currentColor"/><path d="M13.5 9.5h4l3 3.2v2.8h-7z" fill="currentColor" opacity=".85"/>' +
  '<circle cx="6.5" cy="17" r="2" fill="currentColor"/><circle cx="17" cy="17" r="2" fill="currentColor"/>';
const BOX =
  '<path d="M12 2.5 21 7v10l-9 4.5L3 17V7Z" fill="currentColor"/><path d="M3 7l9 4.5L21 7M12 11.5v10" stroke="var(--surface)" stroke-width="1.3" fill="none" opacity=".85"/>';

function glyph(mode: HubMode): { svg: string; rotates: boolean } {
  if (mode === "sea") return { svg: SHIP, rotates: true };
  if (mode === "air") return { svg: PLANE, rotates: true };
  if (mode === "domestic") return { svg: TRUCK, rotates: false };
  return { svg: BOX, rotates: false };
}

/**
 * A tracked-item marker: pulsing status ring + rotating vehicle glyph. The glyph
 * sits in `.hub-rot` so the animation loop can update its rotation without
 * rebuilding the icon.
 */
export function trackIcon(mode: HubMode, status: TrackStatus, selected: boolean): L.DivIcon {
  const { svg } = glyph(mode);
  const color = statusColor(status);
  const moving = status === "in_transit" || status === "out_for_delivery";
  const size = selected ? 44 : 36;
  return L.divIcon({
    className: "hub-marker",
    html:
      `<div class="hub-mk${selected ? " is-sel" : ""}" style="--mk:${color};width:${size}px;height:${size}px">` +
      (moving ? '<span class="hub-pulse"></span>' : "") +
      `<span class="hub-core"><svg class="hub-rot" viewBox="0 0 24 24" width="${selected ? 22 : 18}" height="${selected ? 22 : 18}">${svg}</svg></span>` +
      `</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function glyphRotates(mode: HubMode): boolean {
  return glyph(mode).rotates;
}

/** Small endpoint dot (origin / destination of a tracked item). */
export function endpointIcon(kind: "origin" | "dest", color: string): L.DivIcon {
  const inner =
    kind === "dest"
      ? `<span style="display:block;width:12px;height:12px;border-radius:50%;border:3px solid ${color};background:var(--surface);box-shadow:0 1px 3px rgba(0,0,0,.35)"></span>`
      : `<span style="display:block;width:9px;height:9px;border-radius:50%;background:${color};box-shadow:0 0 0 2px var(--surface),0 1px 3px rgba(0,0,0,.35)"></span>`;
  return L.divIcon({ className: "", html: inner, iconSize: [12, 12], iconAnchor: [6, 6] });
}

/** Ambient AIS vessel: a tiny rotated arrow coloured by ship type. */
export function aisIcon(type: number | null): L.DivIcon {
  const color =
    type != null && type >= 80 && type <= 89
      ? "#d98213" // tanker
      : type != null && type >= 70 && type <= 79
        ? "#0f9b8e" // cargo
        : "#7d8a99";
  return L.divIcon({
    className: "hub-ais",
    html: `<svg class="hub-rot" viewBox="0 0 10 14" width="9" height="13"><path d="M5 0 10 14 5 11 0 14Z" fill="${color}" stroke="rgba(0,0,0,.35)" stroke-width=".6"/></svg>`,
    iconSize: [10, 14],
    iconAnchor: [5, 7],
  });
}

export function setRotation(marker: L.Marker, deg: number): void {
  const el = marker.getElement()?.querySelector<SVGElement>(".hub-rot");
  if (el) el.style.transform = `rotate(${Math.round(deg)}deg)`;
}

/** Scoped CSS for hub markers + animated route lines (injected once by HubCanvas). */
export const HUB_MAP_CSS = `
.hub-marker { background: none; border: 0; }
.hub-mk { position: relative; display: grid; place-items: center; cursor: pointer; transition: transform .18s var(--ease-standard, ease); }
.hub-mk:hover { transform: scale(1.08); }
.hub-core { position: relative; z-index: 1; display: grid; place-items: center; width: 100%; height: 100%;
  border-radius: 50%; background: var(--surface); color: var(--mk);
  box-shadow: 0 0 0 2.5px var(--mk), 0 4px 14px rgba(0,0,0,.28); }
.hub-mk.is-sel .hub-core { box-shadow: 0 0 0 3px var(--mk), 0 0 0 7px color-mix(in srgb, var(--mk) 22%, transparent), 0 6px 18px rgba(0,0,0,.32); }
.hub-rot { transition: transform .6s linear; transform-origin: 50% 50%; }
.hub-pulse { position: absolute; inset: 0; border-radius: 50%; background: var(--mk); opacity: .35; animation: hubPulse 2.2s ease-out infinite; }
@keyframes hubPulse { 0% { transform: scale(.9); opacity: .45 } 100% { transform: scale(2.1); opacity: 0 } }
.hub-ais { background: none; border: 0; }
.hub-ants { stroke-dasharray: 7 9; animation: hubAnts 1.4s linear infinite; }
@keyframes hubAnts { to { stroke-dashoffset: -32 } }
.hub-trail { filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 50%, transparent)); }
@media (prefers-reduced-motion: reduce) {
  .hub-pulse, .hub-ants { animation: none; }
  .hub-rot { transition: none; }
}
`;

// ── Ports / airports / crossings (Phase 2) ───────────────────────────────────

const PORT_GLYPH: Record<string, string> = {
  sea: '<path d="M12 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-.9 4.3h1.8v9.6c2.4-.3 4.2-1.8 4.8-3.9l-1.6.4 2.4-3.4 1.2 4-1.2-.8c-.8 3.3-3.8 5.7-7.5 5.7s-6.7-2.4-7.5-5.7l-1.2.8 1.2-4 2.4 3.4-1.6-.4c.6 2.1 2.4 3.6 4.8 3.9Z" fill="currentColor"/>',
  air: '<path d="M12 2.6c.7 0 1.2.6 1.2 1.4v5.4l6.6 3.9v1.8l-6.6-2v4.1l1.8 1.4v1.4L12 19.2 9 20v-1.4l1.8-1.4v-4.1l-6.6 2v-1.8l6.6-3.9V4c0-.8.5-1.4 1.2-1.4Z" fill="currentColor"/>',
  customs: '<path d="M5 4h14v3H5zM6.5 8h11v11h-11z" fill="currentColor"/><path d="m9.3 13.4 1.9 1.9 3.6-3.8" stroke="var(--surface)" stroke-width="1.8" fill="none"/>',
  inland: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
};

export function portIcon(kind: string, color: string, favorite: boolean, alert: boolean, selected: boolean): L.DivIcon {
  const size = selected ? 30 : 22;
  return L.divIcon({
    className: "hub-marker",
    html:
      `<div class="hub-port${selected ? " is-sel" : ""}${alert ? " is-alert" : ""}" style="--mk:${color};width:${size}px;height:${size}px">` +
      (alert ? '<span class="hub-pulse"></span>' : "") +
      `<span class="hub-pcore"><svg viewBox="0 0 24 24" width="${selected ? 17 : 13}" height="${selected ? 17 : 13}">${PORT_GLYPH[kind] ?? PORT_GLYPH.inland}</svg></span>` +
      (favorite ? '<span class="hub-star">★</span>' : "") +
      `</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export const HUB_PORT_CSS = `
.hub-port { position: relative; display: grid; place-items: center; cursor: pointer; }
.hub-pcore { position: relative; z-index: 1; display: grid; place-items: center; width: 100%; height: 100%;
  border-radius: 7px; background: var(--surface); color: var(--mk);
  box-shadow: 0 0 0 2px var(--mk), 0 2px 8px rgba(0,0,0,.25); }
.hub-port.is-sel .hub-pcore { box-shadow: 0 0 0 2.5px var(--mk), 0 0 0 6px color-mix(in srgb, var(--mk) 22%, transparent), 0 4px 12px rgba(0,0,0,.3); }
.hub-port .hub-pulse { border-radius: 8px; }
.hub-star { position: absolute; z-index: 2; top: -8px; right: -8px; font-size: 12px; line-height: 1; color: #f2b100;
  text-shadow: 0 0 2px var(--surface), 0 0 3px var(--surface); }
`;
