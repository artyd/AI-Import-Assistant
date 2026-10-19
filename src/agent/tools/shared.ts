import type { Citation } from '../../chat/conversations.js';

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
