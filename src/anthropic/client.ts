import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/**
 * Single shared Anthropic client. The API key lives only here (server-side) and
 * is never exposed to the browser — the frontend talks only to this backend.
 */
export const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  // Auto-retry 408/409/429/5xx + connection errors with exponential backoff
  // (honours Retry-After). Raised above the SDK default of 2 so a burst of
  // indexing jobs — each making OCR + field-extraction + classification calls —
  // survives Anthropic rate-limit spikes instead of failing the file.
  maxRetries: config.ANTHROPIC_MAX_RETRIES,
  timeout: config.ANTHROPIC_TIMEOUT_MS,
});

export const MODEL = config.ANTHROPIC_MODEL;

// Derive message/tool param types from the SDK method signature rather than
// naming the flat `Anthropic.MessageParam` aliases: those are re-exported only
// via wildcard and resolve inconsistently between the SDK's .d.ts and .d.mts
// builds (works on Windows/CJS resolution, fails under Vercel's ESM resolution).
// Deriving from `messages.stream`'s params is build-independent.
type StreamParams = Parameters<typeof anthropic.messages.stream>[0];
export type ChatMessageParam = StreamParams['messages'][number];
export type ChatContentBlockParam = Extract<ChatMessageParam['content'], readonly unknown[]>[number];
export type ChatTool = NonNullable<StreamParams['tools']>[number];
