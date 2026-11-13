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
import { DecidedBlock, TriageBar, type TriageCtx } from "./Triage";

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

function FindingRow({ d, onAsk, triage }: { d: Discrepancy & { lot?: string }; onAsk?: Ask; triage?: TriageCtx }) {
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
      {v.cls !== "note" && (onAsk || triage) ? (
        <TriageBar
          ctx={triage}
          fingerprint={d.fingerprint}
          title={v.title}
          lot={v.lot}
          onAskReal={onAsk ? () => onAsk(askPrompts.finding({ title: v.title, values: v.values, files: v.files, lot: v.lot })) : undefined}
          onSolve={onAsk ? () => onAsk(askPrompts.solve({ title: v.title, values: v.values, files: v.files, lot: v.lot ?? triage?.lot })) : undefined}
        />
      ) : null}
    </div>
  );
}

export function DiscrepanciesBlock({
  items,
  title = "Розбіжності",
  emptyText = "Розбіжностей не виявлено.",
  onAsk,
  triage,
}: {
  items: (Discrepancy & { lot?: string })[];
  title?: string;
  emptyText?: string;
  onAsk?: Ask;
  triage?: TriageCtx;
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
        <FindingRow key={d.fingerprint ?? `p${i}`} d={d} onAsk={onAsk} triage={triage} />
      ))}
      {g.check.map((d, i) => (
        <FindingRow key={d.fingerprint ?? `c${i}`} d={d} onAsk={onAsk} triage={triage} />
      ))}
      <Notes count={g.notes.length}>
        {g.notes.map((d, i) => (
          <FindingRow key={`n${i}`} d={d} />
        ))}
      </Notes>
      <DecidedBlock
        ctx={triage}
        items={g.decided.map((d, i) => {
          const v = findingView(d);
          return { key: d.fingerprint ?? `x${i}`, fingerprint: d.fingerprint, title: v.title, lot: v.lot ?? triage?.lot, triage: d.triage! };
        })}
      />
    </div>
  );
}

export function RisksBlock({ risks, title = "Ризики", onAsk, triage }: { risks: Risk[]; title?: string; onAsk?: Ask; triage?: TriageCtx }) {
  const g = groupFindings(risks);
  const problems = [...g.problems, ...g.check];
  return (
    <>
      {title ? <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div> : null}
      {problems.length === 0 ? <div style={{ fontSize: 13, color: g.notes.length ? "var(--muted)" : "var(--ok)" }}>Ризиків не виявлено.</div> : null}
      {problems.map((r, i) => (
        <RiskRow key={r.fingerprint ?? `${r.code}-${i}`} r={r} onAsk={onAsk} triage={triage} />
      ))}
      <Notes count={g.notes.length}>
        {g.notes.map((r, i) => (
          <RiskRow key={`${r.code}-n${i}`} r={r} />
        ))}
      </Notes>
      <DecidedBlock
        ctx={triage}
        items={g.decided.map((r, i) => ({ key: r.fingerprint ?? `${r.code}-x${i}`, fingerprint: r.fingerprint, title: r.title, lot: triage?.lot, triage: r.triage! }))}
      />
    </>
  );
}

function RiskRow({ r, onAsk, triage }: { r: Risk; onAsk?: Ask; triage?: TriageCtx }) {
  const note = r.severity === "info";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, borderLeft: `3px solid ${RISK_CLS[r.severity]}`, paddingLeft: 8 }}>
      <span style={{ fontSize: 13, fontWeight: note ? 500 : 600, color: note ? "var(--muted)" : RISK_CLS[r.severity] }}>{r.title}</span>
      {r.detail ? <span style={{ fontSize: 12, color: "var(--muted)", overflowWrap: "anywhere" }}>{truncate(r.detail, 240)}</span> : null}
      {!note && (onAsk || triage) ? (
        <TriageBar
          ctx={triage}
          fingerprint={r.fingerprint}
          title={r.title}
          onAskReal={onAsk ? () => onAsk(askPrompts.finding({ title: r.title, values: r.detail ? truncate(r.detail, 160) : null })) : undefined}
          onSolve={onAsk ? () => onAsk(askPrompts.solve({ title: r.title, values: r.detail ? truncate(r.detail, 160) : null, lot: triage?.lot })) : undefined}
        />
      ) : null}
    </div>
  );
}
