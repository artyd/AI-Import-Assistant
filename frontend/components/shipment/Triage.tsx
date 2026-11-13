"use client";
import { useState, type CSSProperties, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import type { FindingTriage } from "@/lib/types";
import { requestErrorText } from "@/lib/shipment/findings";
import {
  REASON_LABEL,
  TRIAGE_REASONS,
  NOTE_MAX,
  decidedDate,
  decideFinding,
  decisionText,
  undoFinding,
  validateTriage,
  type TriageReason,
} from "@/lib/shipment/triage";

/**
 * Triage controls of a finding (spec 011): «Не проблема» (reason + note), «Вирішено»,
 * «Як вирішити?», «Запитати» in one compact line, and the collapsed «Розібрано (N)»
 * block with «Повернути».
 */

/** Where a decision is written and how the panel refreshes afterwards. */
export interface TriageCtx {
  /** The shipment id, or the FCL id for findings inside a lot. */
  workspaceId: string;
  /** Lot name for findings of a lot scope (a finding's own `lot` wins). */
  lot?: string | null;
  /** Reload the data so counts and lights update. */
  onChanged: () => Promise<void> | void;
  /** Show a failure to the user (never silent). */
  notify: (text: string) => void;
}

const linkBtn: CSSProperties = {
  border: "none",
  background: "none",
  padding: 0,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--accent)",
};

function failText(err: unknown): string {
  if (err instanceof ApiError) return requestErrorText(err.code);
  if (err instanceof Error && err.message) return err.message;
  return requestErrorText();
}

export function TriageBar({
  ctx,
  fingerprint,
  title,
  lot,
  onAskReal,
  onSolve,
}: {
  ctx?: TriageCtx;
  fingerprint?: string;
  title: string;
  lot?: string | null;
  /** «Запитати» — is this a real problem? */
  onAskReal?: () => void;
  /** «Як вирішити?» */
  onSolve?: () => void;
}) {
  const [mode, setMode] = useState<null | "np" | "resolved">(null);
  const [reason, setReason] = useState<TriageReason | "">("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canTriage = !!ctx && !!fingerprint;

  const close = () => {
    setMode(null);
    setReason("");
    setNote("");
    setErr(null);
  };

  const save = async () => {
    if (!ctx || !fingerprint || !mode) return;
    const status = mode === "np" ? "not_problem" : "resolved";
    const bad = validateTriage({ status, reason, note });
    if (bad) {
      setErr(bad);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await decideFinding(ctx.workspaceId, fingerprint, { status, reason: reason || null, note, title, lot: lot ?? ctx.lot ?? null });
      close();
      await ctx.onChanged();
    } catch (e) {
      const t = failText(e);
      setErr(t);
      ctx.notify(t);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 3 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px" }}>
        {canTriage ? (
          <>
            <button type="button" style={linkBtn} onClick={() => setMode(mode === "np" ? null : "np")} title="Виключити з проблем із причиною">
              Не проблема
            </button>
            <button type="button" style={linkBtn} onClick={() => setMode(mode === "resolved" ? null : "resolved")} title="Позначити як вирішене">
              Вирішено
            </button>
          </>
        ) : null}
        {onSolve ? (
          <button type="button" style={linkBtn} onClick={onSolve} title="Штурман у чаті підкаже кроки і, за потреби, лист постачальнику">
            Як вирішити?
          </button>
        ) : null}
        {onAskReal ? (
          <button type="button" style={linkBtn} onClick={onAskReal} title="Запитати Штурмана в чаті: це справжня проблема?">
            Запитати
          </button>
        ) : null}
      </div>
      {mode ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6, padding: 8, background: "var(--hover)", borderRadius: 8 }}>
          {mode === "np" ? (
            <select className="input" value={reason} onChange={(e) => setReason(e.target.value as TriageReason | "")} aria-label="Причина" style={{ height: 30, fontSize: 12 }}>
              <option value="">Причина…</option>
              {TRIAGE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {REASON_LABEL[r]}
                </option>
              ))}
            </select>
          ) : null}
          <textarea
            className="input"
            value={note}
            maxLength={NOTE_MAX}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            placeholder={mode === "np" ? (reason === "other" ? "Коментар (обов’язково)" : "Коментар (необов’язково)") : "Коментар (необов’язково)"}
            aria-label="Коментар"
            style={{ fontSize: 12, resize: "vertical" }}
          />
          {err ? <div style={{ fontSize: 12, color: "var(--err)" }}>{err}</div> : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()} style={{ height: 28, fontSize: 12 }}>
              {busy ? "Зберігаю…" : "Зберегти"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={close} style={{ height: 28, fontSize: 12 }}>
              Скасувати
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface DecidedItem {
  key: string;
  fingerprint?: string;
  title: string;
  lot?: string | null;
  triage: FindingTriage;
}

/** «Розібрано (N)» — collapsed list of decided findings, each with «Повернути». */
export function DecidedBlock({ items, ctx }: { items: DecidedItem[]; ctx?: TriageCtx }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (items.length === 0) return null;

  const undo = async (it: DecidedItem) => {
    if (!ctx || !it.fingerprint) return;
    setBusy(it.key);
    try {
      await undoFinding(ctx.workspaceId, it.fingerprint);
      await ctx.onChanged();
    } catch (e) {
      ctx.notify(failText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <details style={{ fontSize: 12, color: "var(--muted)" }}>
      <summary style={{ cursor: "pointer", userSelect: "none" }}>Розібрано ({items.length})</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
        {items.map((it) => (
          <DecidedRow key={it.key} it={it} canUndo={!!ctx && !!it.fingerprint} busy={busy === it.key} onUndo={() => void undo(it)} />
        ))}
      </div>
    </details>
  );
}

function DecidedRow({ it, canUndo, busy, onUndo }: { it: DecidedItem; canUndo: boolean; busy: boolean; onUndo: () => void }): ReactNode {
  const date = decidedDate(it.triage.decided_at);
  return (
    <div style={{ borderLeft: "3px solid var(--border2)", paddingLeft: 8, minWidth: 0 }}>
      <div style={{ fontWeight: 600, color: "var(--text)", overflowWrap: "anywhere" }}>
        {it.title}
        {it.lot ? <span style={{ fontWeight: 500, color: "var(--muted)" }}> · {it.lot}</span> : null}
      </div>
      <div style={{ overflowWrap: "anywhere" }}>{decisionText(it.triage)}</div>
      <div style={{ fontSize: 11 }}>
        {it.triage.user_name}
        {date ? ` · ${date}` : ""}
        {canUndo ? (
          <>
            {" · "}
            <button
              type="button"
              disabled={busy}
              onClick={onUndo}
              style={{ border: "none", background: "none", padding: 0, cursor: "pointer", fontSize: 11, fontWeight: 600, color: "var(--accent)" }}
            >
              {busy ? "Повертаю…" : "Повернути"}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
