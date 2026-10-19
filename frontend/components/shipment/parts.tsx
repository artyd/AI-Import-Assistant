"use client";
import { type CSSProperties, type ReactNode } from "react";
import { STATUS_LABEL } from "../layout/TopBar";
import type { ChecklistItem, Discrepancy } from "@/lib/types";
import { IconSpinner } from "../ui/icons";
import { LnCheck, LnExport } from "../ui/LineIcons";
import { CHECK_CLS, CHECK_LABEL, FIELD_LABEL, REQ_LABEL } from "./labels";

export type Result =
  | { kind: "checklist"; items: ChecklistItem[]; status: string }
  | { kind: "discrepancies"; items: Discrepancy[] }
  | { kind: "text"; title: string; body: string }
  | { kind: "error"; body: string };

export function ResultView({ result }: { result: Result }) {
  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      {result.kind === "checklist" && (
        <>
          <SectionTitle>Комплектність · {STATUS_LABEL[result.status as keyof typeof STATUS_LABEL] ?? result.status}</SectionTitle>
          {result.items.length === 0 ? (
            <Muted>Чек-лист порожній — заповніть параметри постачання.</Muted>
          ) : (
            result.items.map((i) => (
              <div key={i.requirement_key} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span>{reqLabel(i.requirement_key)}</span>
                <span style={{ color: CHECK_CLS[i.status], fontWeight: 600 }}>{CHECK_LABEL[i.status]}</span>
              </div>
            ))
          )}
        </>
      )}
      {result.kind === "discrepancies" && (
        <>
          <SectionTitle>Розбіжності</SectionTitle>
          {result.items.length === 0 ? (
            <Muted>Розбіжностей не виявлено.</Muted>
          ) : (
            result.items.map((d, i) => {
              const confirmed = d.kind !== "suspected";
              const color =
                d.severity === "error" ? "var(--err)" : d.severity === "warning" ? "var(--warn)" : "var(--muted)";
              return (
                <div key={i} style={{ fontSize: 13, borderLeft: `3px solid ${color}`, paddingLeft: 8 }}>
                  <span style={{ fontWeight: 600, color }}>
                    {confirmed ? "🔴" : "🟡"} {FIELD_LABEL[d.field] ?? d.field}
                  </span>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>{d.expected} → {d.actual}</div>
                  {d.citations && d.citations.length > 0 && (
                    <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>
                      {d.citations.map((c, j) => (
                        <div key={j}>
                          ↳ {c.doc_type}
                          {c.file_name ? ` · «${c.file_name}»` : ""}: {c.value}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
          <Muted>🔴 — підтверджена розбіжність (з джерелами) · 🟡 — потребує перевірки</Muted>
        </>
      )}
      {result.kind === "text" && (
        <>
          <SectionTitle>{result.title}</SectionTitle>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-sans)", fontSize: 13, margin: 0 }}>{result.body}</pre>
        </>
      )}
      {result.kind === "error" && <div style={{ color: "var(--err)", fontSize: 13 }}>{result.body}</div>}
    </div>
  );
}

export const lbl: CSSProperties = { fontSize: 12, color: "var(--muted)" };
function reqLabel(key: string): string {
  return REQ_LABEL[key] ?? key.replace(/_/g, " ");
}

export function CompletenessHeader({
  items,
  onExport,
  exporting,
}: {
  items: ChecklistItem[];
  onExport: () => void;
  exporting: boolean;
}) {
  const done = items.filter((i) => i.status !== "missing").length;
  const total = items.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const color = pct >= 100 ? "var(--ok)" : pct >= 50 ? "var(--warn)" : "var(--err)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>Комплектність пакета</span>
        <span style={{ fontSize: 12, fontWeight: 600, color, fontVariantNumeric: "tabular-nums" }}>
          {done}/{total}
        </span>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: "var(--hover)", overflow: "hidden", marginBottom: 16 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 4, transition: "width .3s" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {items.map((ci) => {
          const ok = ci.status !== "missing";
          return (
            <div key={ci.requirement_key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
              {ok ? (
                <span
                  style={{
                    flex: "none",
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "var(--okBg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--ok)",
                  }}
                >
                  <LnCheck size={11} strokeWidth={3.2} />
                </span>
              ) : (
                <span
                  style={{
                    flex: "none",
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    border: "1.5px dashed var(--border2)",
                  }}
                />
              )}
              <span style={{ flex: 1, minWidth: 0, color: ok ? "var(--text)" : "var(--muted)", textTransform: "capitalize" }}>
                {reqLabel(ci.requirement_key)}
              </span>
            </div>
          );
        })}
      </div>
      <button
        onClick={onExport}
        disabled={exporting}
        className="btn btn-primary"
        style={{ width: "100%", marginTop: 18, height: 40 }}
      >
        {exporting ? <IconSpinner size={15} /> : <LnExport size={15} />} Експорт пакета
      </button>
    </div>
  );
}

export function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label style={lbl}>{label}</label>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </div>
  );
}
function SectionTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontWeight: 600, fontSize: 13 }}>{children}</div>;
}
function Muted({ children }: { children: ReactNode }) {
  return <div style={{ color: "var(--muted)", fontSize: 13 }}>{children}</div>;
}
