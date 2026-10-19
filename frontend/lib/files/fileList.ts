import type { DocsStatus, FileItem, FileStatusEvent } from "@/lib/types";

// Pure operations on a shipment's file list. The hook (useShipmentFiles) owns
// the state; every change goes through one of these, so each is testable.

/** Apply one live file_status event (also used to replay events on a refreshed snapshot). */
export function applyFileStatus(prev: FileItem[], ev: FileStatusEvent): FileItem[] {
  if (ev.status === "deleted") return prev.filter((f) => f.id !== ev.fileId);
  const idx = prev.findIndex((f) => f.id === ev.fileId);
  if (idx === -1) {
    if (!ev.name) return prev;
    return [
      ...prev,
      {
        id: ev.fileId,
        folderId: ev.folderId ?? null,
        name: ev.name,
        type: "",
        status: ev.status,
        errorReason: ev.errorReason ?? null,
      },
    ];
  }
  const next = [...prev];
  next[idx] = {
    ...next[idx]!,
    status: ev.status,
    errorReason: ev.errorReason ?? next[idx]!.errorReason,
    folderId: ev.folderId !== undefined ? ev.folderId : next[idx]!.folderId,
  };
  return next;
}

/** A refreshed snapshot with the events that arrived meanwhile re-applied on top. */
export function replayOnSnapshot(snapshot: FileItem[], buffered: FileStatusEvent[]): FileItem[] {
  return buffered.reduce(applyFileStatus, snapshot);
}

/** Add uploaded files that the live channel has not added already. */
export function withUploaded(prev: FileItem[], created: FileItem[]): FileItem[] {
  const known = new Set(prev.map((p) => p.id));
  return [...prev, ...created.filter((f) => !known.has(f.id))];
}

export function withPatch(prev: FileItem[], id: string, patch: Partial<FileItem>): FileItem[] {
  return prev.map((f) => (f.id === id ? { ...f, ...patch } : f));
}

export function without(prev: FileItem[], id: string): FileItem[] {
  return prev.filter((f) => f.id !== id);
}

/** Undo an optimistic delete: put the file back where it was, unless it already returned. */
export function restored(prev: FileItem[], file: FileItem, index: number): FileItem[] {
  if (prev.some((f) => f.id === file.id)) return prev;
  const next = [...prev];
  next.splice(Math.min(Math.max(index, 0), next.length), 0, file);
  return next;
}

/** The «Документи» meter: how much of the shipment the agent can already read. */
export function docsStatusOf(files: FileItem[]): DocsStatus | null {
  const latest = files.filter((f) => f.isLatest !== false);
  if (latest.length === 0) return null;
  return {
    total: latest.length,
    ready: latest.filter((f) => f.status === "ready").length,
    inProgress: latest.filter((f) => f.status === "queued" || f.status === "indexing").length,
    errors: latest.filter((f) => f.status === "error").length,
    needsAttention: latest.filter(
      (f) => f.status === "ready" && (f.extractionStatus === "unreadable" || f.extractionStatus === "failed")
    ).length,
  };
}

// Run an async mapper over items with bounded concurrency, preserving order.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
