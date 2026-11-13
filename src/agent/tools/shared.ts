import type { Citation } from '../../chat/conversations.js';
import { REASON_LABELS, STATUS_LABELS, type FindingTriage } from '../../reconciliation/fingerprint.js';

/**
 * Findings the user already decided (spec 011), listed apart from the problems:
 * «Розібрано користувачем:». Empty string when there are none.
 */
export function decidedBlock(items: { text: string; triage?: FindingTriage }[]): string {
  const done = items.filter((i) => i.triage);
  if (done.length === 0) return '';
  const lines = done.map(({ text, triage: t }) => {
    const why = t!.reason ? `, причина: ${REASON_LABELS[t!.reason]}` : '';
    const note = t!.note ? `, примітка: ${t!.note}` : '';
    return `- ${text} — ${STATUS_LABELS[t!.status]}${why}${note}`;
  });
  return `Розібрано користувачем:\n${lines.join('\n')}`;
}

/**
 * Tool execution scope. Shipment ("supply") tools need a `workspaceId`; the
 * consolidated-analysis tool needs a `collectionId` (+ `ownerId` to persist).
 * Both are optional so one shape covers every chat kind — handlers narrow via
 * `requireWorkspace(ctx)` / `requireCollection(ctx)`.
 */
export interface ToolContext {
  workspaceId?: string;
  collectionId?: string;
  ownerId?: string;
}

/** Narrows to a shipment scope; throws if the tool was called without one. */
export function requireWorkspace(ctx: ToolContext): string {
  if (!ctx.workspaceId) throw new Error('Цей інструмент доступний лише в межах постачання.');
  return ctx.workspaceId;
}

export interface ToolOutcome {
  /** Text returned to the model as the tool_result content. */
  result: string;
  /** Short human-readable summary for the tool_result SSE event / agent log. */
  summary: string;
  /** Sources surfaced by this tool call, for inline citation chips. */
  citations: Citation[];
}
