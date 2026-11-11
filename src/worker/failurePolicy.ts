/**
 * BullMQ 'failed' fires after every attempt; `attemptsMade` already counts the
 * one that just failed. Only the last one is worth an ops alert.
 */
export function isFinalFailure(attemptsMade: number, attempts: number | undefined): boolean {
  return attemptsMade >= (attempts ?? 1);
}
