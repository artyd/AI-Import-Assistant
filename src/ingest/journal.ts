import { query } from '../db/pool.js';
import { publishOn, subscribeChannel } from '../lib/events/fileStatus.js';

/**
 * The reading journal (spec 007): what Штурман is doing with a shipment's files —
 * "Читаю …", "Прочитано: інвойс від A", "Кладу → Митниця / A". Stored (the
 * Журнал tab) and published live (the chat feed, SSE `ingest_log`).
 */
export type IngestEventKind = 'read' | 'progress' | 'done' | 'file' | 'warn' | 'error' | 'summary';

export interface IngestEvent {
  id: string;
  fileId: string | null;
  batchId: string | null;
  kind: IngestEventKind;
  text: string;
  createdAt: string;
}

const channel = (workspaceId: string): string => `ingest_log:${workspaceId}`;

/** Records one journal line. Best-effort: the journal never fails the ingest. */
export async function logIngest(
  workspaceId: string,
  e: { fileId?: string | null; batchId?: string | null; kind: IngestEventKind; text: string },
): Promise<void> {
  try {
    const { rows } = await query<IngestEvent>(
      `INSERT INTO ingest_events (workspace_id, file_id, batch_id, kind, text)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id::text, file_id AS "fileId", batch_id AS "batchId", kind, text, created_at AS "createdAt"`,
      [workspaceId, e.fileId ?? null, e.batchId ?? null, e.kind, e.text],
    );
    await publishOn(channel(workspaceId), rows[0]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Journal write failed for workspace ${workspaceId}:`, (err as Error).message);
  }
}

/** The newest journal lines (oldest first), optionally only after a known id. */
export async function listIngestEvents(workspaceId: string, limit: number, afterId?: string): Promise<IngestEvent[]> {
  const { rows } = await query<IngestEvent & { seq: string }>(
    `SELECT * FROM (
       SELECT id::text, file_id AS "fileId", batch_id AS "batchId", kind, text, created_at AS "createdAt", id AS seq
       FROM ingest_events
       WHERE workspace_id = $1 AND ($3::bigint IS NULL OR id > $3::bigint)
       ORDER BY id DESC LIMIT $2
     ) t ORDER BY seq`,
    [workspaceId, limit, afterId ?? null],
  );
  return rows.map(({ seq: _seq, ...e }) => e);
}

export function subscribeIngestEvents(workspaceId: string, onEvent: (e: IngestEvent) => void): () => Promise<void> {
  return subscribeChannel(channel(workspaceId), onEvent as (e: unknown) => void);
}

/** A file's name in journal lines. */
export const q = (name: string): string => `«${name}»`;
