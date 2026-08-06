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

/**
 * Subscribes to a workspace's status channel. Returns an async close function.
 * Each subscription uses its own connection (Redis subscribe mode is exclusive).
 */
export function subscribeFileStatus(
  workspaceId: string,
  onEvent: (event: FileStatusEvent) => void,
): () => Promise<void> {
  const sub = createRedis();
  void sub.subscribe(channel(workspaceId));
  sub.on('message', (_ch: string, payload: string) => {
    try {
      onEvent(JSON.parse(payload) as FileStatusEvent);
    } catch {
      // Ignore malformed payloads.
    }
  });
  return async () => {
    await sub.quit();
  };
}
