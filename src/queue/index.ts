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
    {
      removeOnComplete: true,
      removeOnFail: 500,
      // More attempts + a longer exponential backoff so a file whose indexing
      // hit a transient rate-limit / network error (beyond the Anthropic SDK's
      // own in-call retries) is re-tried over minutes rather than given up on
      // after 2 quick tries. 5 attempts ≈ 5s,10s,20s,40s between them.
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );
}
