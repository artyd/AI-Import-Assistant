import type { FileItem, IngestEvent } from "@/lib/types";

/** The Журнал row shape (mirrors components/chat/AgentLog LogEntry). */
export interface JournalRow {
  id: string;
  time: string;
  text: string;
  kind: "call" | "result" | "info" | "warn";
  /** Epoch ms, for merging with the chat's tool log. */
  at: number;
}

const KIND: Record<IngestEvent["kind"], JournalRow["kind"]> = {
  read: "call",
  progress: "call",
  done: "result",
  file: "result",
  warn: "warn",
  error: "warn",
  summary: "info",
};

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Reading-journal lines as Журнал rows. */
export function journalRows(events: IngestEvent[]): JournalRow[] {
  return events.map((e) => {
    const d = new Date(e.createdAt);
    return { id: `j${e.id}`, time: hhmm(d), text: e.text, kind: KIND[e.kind], at: d.getTime() };
  });
}

/** One Журнал: the reading journal and the chat's tool calls, by time. */
export function mergeJournal<T extends { at?: number }>(journal: (T & { at: number })[], chat: T[]): T[] {
  return [...journal, ...chat]
    .map((row, i) => ({ row, i, at: row.at ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.row);
}

export interface ReadingState {
  /** Show the live feed in the chat. */
  active: boolean;
  read: number;
  total: number;
  /** The newest lines, oldest first. */
  lines: IngestEvent[];
}

/**
 * The chat's live reading feed: shown while files are being read or filed, and
 * for a short while after the last line so the summary can be seen.
 */
export function readingState(events: IngestEvent[], files: FileItem[], now: number, keep = 8, lingerMs = 120_000): ReadingState {
  const latest = files.filter((f) => f.isLatest !== false);
  const pending = latest.filter((f) => f.status === "queued" || f.status === "indexing").length;
  const last = events[events.length - 1];
  const recent = !!last && now - new Date(last.createdAt).getTime() < lingerMs;
  return {
    active: pending > 0 || recent,
    read: latest.length - pending,
    total: latest.length,
    lines: events.slice(-keep),
  };
}
