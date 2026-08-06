import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/**
 * Single shared Anthropic client. The API key lives only here (server-side) and
 * is never exposed to the browser — the frontend talks only to this backend.
 */
export const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

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
