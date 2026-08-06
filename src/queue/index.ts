import { Queue } from 'bullmq';
import { createRedis } from './connection.js';

export const INDEX_QUEUE = 'indexing';

export interface IndexJobData {
  fileId: string;
}

export const indexingQueue = new Queue<IndexJobData>(INDEX_QUEUE, {
  connection: createRedis(),
});

/** Enqueue a background indexing job for a freshly-uploaded file. */
export async function enqueueIndexJob(fileId: string): Promise<void> {
  await indexingQueue.add(
    'index',
    { fileId },
    { removeOnComplete: true, removeOnFail: 100, attempts: 2, backoff: { type: 'exponential', delay: 2000 } },
  );
}
