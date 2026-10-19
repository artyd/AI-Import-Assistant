"use client";
import { type CalEvent, type CalRow, fmtDay, EVENT_META, CARGO_META } from "@/lib/calendar";

// ── Print ────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A clean printable plan of the visible events (the browser saves it as PDF). */
export function printPlan(title: string, events: CalEvent[], rowsById: Map<string, CalRow>) {
  const w = window.open("", "_blank");
  if (!w) return;
  const rows = events
    .map((e) => {
      const r = rowsById.get(e.rowId);
      if (!r) return "";
      const num = r.number ? (r.trackLink ? `<a href="${esc(r.trackLink)}">${esc(r.number)}</a>` : esc(r.number)) : "";
      return `<tr><td>${fmtDay(e.date)}${e.approx ? " ≈" : ""}</td><td>${esc(EVENT_META[e.type].label)}${e.source ? ` (${esc(e.source)})` : ""}</td><td>${esc(CARGO_META[r.cargoType].label)}</td><td><b>${esc(r.product)}</b></td><td>${num}</td><td>${esc([r.origin, r.destination].filter(Boolean).join(" → "))}</td><td>${esc(r.forwarder)}</td><td>${esc(r.logist)}</td><td>${esc(r.statusLabel)}</td></tr>`;
    })
    .join("");
  w.document.write(`<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Календар логістів — ${esc(title)}</title>
<style>body{font:13px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:18px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f1f5f9}</style></head>
<body><h1>Календар логістів — ${esc(title)}</h1><table><thead><tr><th>Дата</th><th>Подія</th><th>Тип</th><th>Товар</th><th>Трек-номер</th><th>Маршрут</th><th>Хто везе</th><th>Логіст</th><th>Статус</th></tr></thead><tbody>${rows}</tbody></table>
<p style="color:#666;font-size:11px">«≈» — рік у таблиці не вказано або дата орієнтовна. Джерело: робоча таблиця.</p></body></html>`);
  w.document.close();
  w.focus();
  w.print();
}
