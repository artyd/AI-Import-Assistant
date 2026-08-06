import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/**
 * Single shared Anthropic client. The API key lives only here (server-side) and
 * is never exposed to the browser — the frontend talks only to this backend.
 */
export const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export const MODEL = config.ANTHROPIC_MODEL;
