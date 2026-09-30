import type { Redis } from 'ioredis';
import { createRedis } from '../queue/connection.js';

/**
 * Real-time file indexing-status channel over Redis pub/sub. The worker
 * publishes status transitions; the backend's SSE `/events` endpoint subscribes
 * per-workspace and forwards them to the browser so the file-tree status dots
 * update live.
 */
export interface FileStatusEvent {
  fileId: string;
  status: 'queued' | 'indexing' | 'ready' | 'error' | 'deleted';
  name?: string;
  errorReason?: string | null;
  // Present when the worker auto-filed an inbox file (e.g. a scan classified via
  // OCR) so the file tree can move it live without a refetch.
  folderId?: string | null;
}

function channel(workspaceId: string): string {
  return `file_status:${workspaceId}`;
}

let publisher: Redis | null = null;
function getPublisher(): Redis {
  if (!publisher) publisher = createRedis();
  return publisher;
}

export async function publishFileStatus(
  workspaceId: string,
  event: FileStatusEvent,
): Promise<void> {
  await getPublisher().publish(channel(workspaceId), JSON.stringify(event));
}

// ONE shared subscriber connection per process (Redis subscribe mode makes it
// exclusive to subscriptions), fanned out to listeners by channel — it used to
// be one Redis connection per open browser tab.
let subscriber: Redis | null = null;
const listeners = new Map<string, Set<(event: FileStatusEvent) => void>>();

function getSubscriber(): Redis {
  if (subscriber) return subscriber;
  subscriber = createRedis();
  subscriber.on('message', (ch: string, payload: string) => {
    const set = listeners.get(ch);
    if (!set || set.size === 0) return;
    let event: FileStatusEvent;
    try {
      event = JSON.parse(payload) as FileStatusEvent;
    } catch {
      return; // Ignore malformed payloads.
    }
    for (const fn of set) fn(event);
  });
  return subscriber;
}

/** Subscribes to a workspace's status channel. Returns an async close function. */
export function subscribeFileStatus(
  workspaceId: string,
  onEvent: (event: FileStatusEvent) => void,
): () => Promise<void> {
  const ch = channel(workspaceId);
  const sub = getSubscriber();
  let set = listeners.get(ch);
  if (!set) {
    set = new Set();
    listeners.set(ch, set);
    void sub.subscribe(ch);
  }
  set.add(onEvent);
  return async () => {
    const cur = listeners.get(ch);
    if (!cur) return;
    cur.delete(onEvent);
    if (cur.size === 0) {
      listeners.delete(ch);
      await sub.unsubscribe(ch).catch(() => undefined);
    }
  };
}
