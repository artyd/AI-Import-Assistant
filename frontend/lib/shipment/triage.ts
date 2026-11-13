// Finding triage (spec 011): the declarant decides a finding — «Не проблема» (with a
// reason) or «Вирішено» — and it stays decided. Pure client for the three endpoints
// plus the labels and the validator the inline picker uses.

import { api } from "@/lib/api";
import type { FindingTriage } from "@/lib/types";

export type TriageStatus = "not_problem" | "resolved";
export type TriageReason = "legs" | "version" | "lots" | "agreed" | "other";

export const TRIAGE_REASONS: TriageReason[] = ["legs", "version", "lots", "agreed", "other"];

export const REASON_LABEL: Record<TriageReason, string> = {
  legs: "Різні плечі угоди",
  version: "Інша версія / копія",
  lots: "Різні партії / товари",
  agreed: "Погоджено з брокером / митницею",
  other: "Інше",
};

export const NOTE_MAX = 1000;
export const TITLE_MAX = 300;

export interface TriageInput {
  status: TriageStatus;
  reason?: TriageReason | "" | null;
  note?: string;
}

/** A human error text when the decision cannot be saved, else null. */
export function validateTriage(i: TriageInput): string | null {
  const note = (i.note ?? "").trim();
  if (note.length > NOTE_MAX) return `Коментар задовгий (до ${NOTE_MAX} символів).`;
  if (i.status === "not_problem") {
    if (!i.reason) return "Оберіть причину.";
    if (i.reason === "other" && !note) return "Для причини «Інше» напишіть коментар.";
  }
  return null;
}

export interface DecideBody {
  status: TriageStatus;
  reason?: TriageReason | "" | null;
  note?: string;
  /** What the finding said — kept for the problems report. */
  title: string;
  /** Lot name when the finding is inside an FCL lot. */
  lot?: string | null;
}

const path = (workspaceId: string, fingerprint: string) =>
  `/api/workspaces/${workspaceId}/findings/${encodeURIComponent(fingerprint)}/triage`;

/** PUT: mark a finding decided. `workspaceId` is the FCL id for a lot's finding. */
export async function decideFinding(workspaceId: string, fingerprint: string, body: DecideBody): Promise<FindingTriage> {
  const bad = validateTriage(body);
  if (bad) throw new Error(bad);
  const payload: Record<string, unknown> = {
    status: body.status,
    note: (body.note ?? "").trim(),
    title: body.title.slice(0, TITLE_MAX),
  };
  if (body.status === "not_problem" && body.reason) payload.reason = body.reason;
  if (body.lot) payload.lot = body.lot;
  const r = await api<{ triage: FindingTriage }>(path(workspaceId, fingerprint), { method: "PUT", body: payload });
  return r.triage;
}

/** DELETE: «Повернути» — the finding is open again. */
export async function undoFinding(workspaceId: string, fingerprint: string): Promise<void> {
  await api(path(workspaceId, fingerprint), { method: "DELETE" });
}

/** GET the printable «Звіт про проблеми» and open it in a new tab. */
export async function openProblemsReport(workspaceId: string): Promise<void> {
  const r = await api<{ html: string }>(`/api/workspaces/${workspaceId}/problems-report`);
  const url = URL.createObjectURL(new Blob([r.html], { type: "text/html" }));
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** «Не проблема: Різні плечі угоди — коментар» / «Вирішено — коментар». */
export function decisionText(t: Pick<FindingTriage, "status" | "reason" | "note">): string {
  const note = t.note.trim();
  if (t.status === "resolved") return note ? `Вирішено — ${note}` : "Вирішено";
  const reason = t.reason ? (REASON_LABEL[t.reason as TriageReason] ?? "Інше") : "";
  return `Не проблема${reason ? `: ${reason}` : ""}${note ? ` — ${note}` : ""}`;
}

/** «13.11.2026» from an ISO timestamp; empty on a bad date. */
export function decidedDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("uk-UA");
}
