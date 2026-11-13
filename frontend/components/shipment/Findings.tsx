"use client";
import type { ReactNode } from "react";
import type { Discrepancy, Risk } from "@/lib/types";
import { RISK_CLS } from "./labels";
import {
  type FindingClass,
  findingView,
  groupFindings,
  summarizeFindings,
  summaryText,
  truncate,
} from "@/lib/shipment/findings";
import { askPrompts } from "@/lib/chat/askBus";

/**
 * Discrepancies and risks as the user should read them: problems (error + warning)
 * first, «перевірити» for suspicions, and info notes collapsed under «Примітки (N)».
 * Notes never appear in red/amber counts.
 */

const CLS_COLOR: Record<FindingClass, string> = { problem: "var(--err)", check: "var(--warn)", note: "var(--muted)" };

function Notes({ count, children }: { count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <details style={{ fontSize: 12, color: "var(--muted)" }}>
      <summary style={{ cursor: "pointer", userSelect: "none" }}>Примітки ({count})</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>{children}</div>
    </details>
  );
}

/** A question about one finding to the chat (when the panel is wired to askBus). */
type Ask = (text: string) => void;

function AskBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Запитати Штурмана в чаті: це справжня проблема?"
      style={{ border: "none", background: "none", padding: 0, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--accent)", marginTop: 2 }}
    >
      Запитати
    </button>
  );
}

function FindingRow({ d, onAsk }: { d: Discrepancy & { lot?: string }; onAsk?: Ask }) {
  const v = findingView(d);
  const color = v.cls === "problem" ? (d.severity === "error" ? "var(--err)" : "var(--warn)") : CLS_COLOR[v.cls];
  return (
    <div style={{ fontSize: 13, borderLeft: `3px solid ${color}`, paddingLeft: 8, minWidth: 0 }}>
      <div style={{ fontWeight: v.cls === "note" ? 500 : 600, color: v.cls === "note" ? "var(--muted)" : color }}>
        {v.title}
        {v.cls === "check" ? <span style={{ fontWeight: 500 }}> · перевірити</span> : null}
        {v.lot ? <span style={{ fontWeight: 500, color: "var(--muted)" }}> · {v.lot}</span> : null}
      </div>
      {v.values ? <div style={{ color: "var(--muted)", fontSize: 12, overflowWrap: "anywhere" }}>{v.values}</div> : null}
      {v.files ? <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 1, overflowWrap: "anywhere" }}>↳ {v.files}</div> : null}
      {onAsk && v.cls !== "note" ? <AskBtn onClick={() => onAsk(askPrompts.finding({ title: v.title, values: v.values, files: v.files, lot: v.lot }))} /> : null}
    </div>
  );
}

export function DiscrepanciesBlock({
  items,
  title = "Розбіжності",
  emptyText = "Розбіжностей не виявлено.",
  onAsk,
}: {
  items: (Discrepancy & { lot?: string })[];
  title?: string;
  emptyText?: string;
  onAsk?: Ask;
}) {
  const s = summarizeFindings(items);
  const g = groupFindings(items);
  const head = summaryText(s);
  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>
        {title}
        {head ? <span style={{ fontWeight: 500, color: s.tone === "err" ? "var(--err)" : s.tone === "warn" ? "var(--warn)" : "var(--muted)" }}> · {head}</span> : null}
      </div>
      {s.problems === 0 ? <div style={{ color: "var(--muted)", fontSize: 13 }}>{emptyText}</div> : null}
      {g.problems.map((d, i) => (
        <FindingRow key={`p${i}`} d={d} onAsk={onAsk} />
      ))}
      {g.check.map((d, i) => (
        <FindingRow key={`c${i}`} d={d} onAsk={onAsk} />
      ))}
      <Notes count={g.notes.length}>
        {g.notes.map((d, i) => (
          <FindingRow key={`n${i}`} d={d} />
        ))}
      </Notes>
    </div>
  );
}

export function RisksBlock({ risks, title = "Ризики", onAsk }: { risks: Risk[]; title?: string; onAsk?: Ask }) {
  const g = groupFindings(risks);
  const problems = [...g.problems, ...g.check];
  return (
    <>
      {title ? <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div> : null}
      {problems.length === 0 ? <div style={{ fontSize: 13, color: g.notes.length ? "var(--muted)" : "var(--ok)" }}>Ризиків не виявлено.</div> : null}
      {problems.map((r, i) => (
        <RiskRow key={`${r.code}-${i}`} r={r} onAsk={onAsk} />
      ))}
      <Notes count={g.notes.length}>
        {g.notes.map((r, i) => (
          <RiskRow key={`${r.code}-n${i}`} r={r} />
        ))}
      </Notes>
    </>
  );
}

function RiskRow({ r, onAsk }: { r: Risk; onAsk?: Ask }) {
  const note = r.severity === "info";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, borderLeft: `3px solid ${RISK_CLS[r.severity]}`, paddingLeft: 8 }}>
      <span style={{ fontSize: 13, fontWeight: note ? 500 : 600, color: note ? "var(--muted)" : RISK_CLS[r.severity] }}>{r.title}</span>
      {r.detail ? <span style={{ fontSize: 12, color: "var(--muted)", overflowWrap: "anywhere" }}>{truncate(r.detail, 240)}</span> : null}
      {onAsk && !note ? <AskBtn onClick={() => onAsk(askPrompts.finding({ title: r.title, values: r.detail ? truncate(r.detail, 160) : null }))} /> : null}
    </div>
  );
}
