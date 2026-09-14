import { anthropic, MODEL } from '../../anthropic/client.js';
import type { AiProvider } from './providers.js';

/**
 * BYOK proxy for the consolidated-analysis AI step (Phase E).
 *
 * `callAnalysisAi(ownerId, ...)` is the single entry point the analysis engine
 * uses instead of talking to Anthropic directly:
 *  - no `ownerId`, no config, or `engine='builtin'` → OUR server-side Claude
 *    (MODEL), byte-identical to the pre-Phase-E behaviour;
 *  - `engine='byok'` (and BYOK enabled) → the user's provider via `callProvider`,
 *    with the decrypted key resolved server-side.
 *
 * On ANY byok failure (bad key, provider down, decrypt error, DB error) we log
 * and fall back to built-in so analysis never hard-fails on a user's config.
 *
 * Config/pool/crypto/providers are imported lazily so the built-in path never
 * pulls in `config.ts` (keeps deterministic unit tests free of env/DB coupling).
 */

export type ResolvedAi =
  | { mode: 'builtin' }
  | { mode: 'byok'; provider: AiProvider; apiKey: string };

export interface AnalysisAiRequest {
  system: string;
  user: string;
  maxTokens: number;
}

/** JSON nudge appended to the user turn for the built-in Claude (matches ai.ts). */
const JSON_SUFFIX = '\n\nПоверни ТІЛЬКИ валідний JSON, без markdown.';

/**
 * Read a user's AI config. Returns `{ mode:'builtin' }` unless the user has an
 * enabled BYOK config with a stored key AND BYOK_ENC_KEY is set. Never throws:
 * any DB/decrypt problem degrades to built-in.
 */
export async function resolveAi(ownerId: string): Promise<ResolvedAi> {
  try {
    const { byokEnabled, decryptSecret } = await import('./crypto.js');
    if (!byokEnabled()) return { mode: 'builtin' };

    const { query } = await import('../../db/pool.js');
    const { rows } = await query<{
      engine: string;
      provider: string | null;
      enc_key: string | null;
    }>('SELECT engine, provider, enc_key FROM ai_configs WHERE user_id = $1', [ownerId]);
    const row = rows[0];
    if (!row || row.engine !== 'byok' || !row.provider || !row.enc_key) {
      return { mode: 'builtin' };
    }
    const apiKey = decryptSecret(row.enc_key);
    return { mode: 'byok', provider: row.provider as AiProvider, apiKey };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[aiProxy] resolveAi failed — using built-in Claude:', (err as Error).message);
    return { mode: 'builtin' };
  }
}

/** Built-in server-side Claude call — identical to the pre-Phase-E ai.ts path. */
async function callBuiltin(req: AnalysisAiRequest): Promise<string> {
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user', content: `${req.user}${JSON_SUFFIX}` }],
  });
  let raw = '';
  for (const block of resp.content) {
    if (block.type === 'text') raw += block.text;
  }
  return raw;
}

/**
 * Run one analysis AI request for `ownerId`. Built-in unless the user opted into
 * BYOK; any BYOK error falls back to built-in.
 */
export async function callAnalysisAi(
  ownerId: string | undefined,
  req: AnalysisAiRequest,
): Promise<string> {
  if (ownerId) {
    const resolved = await resolveAi(ownerId);
    if (resolved.mode === 'byok') {
      try {
        const { callProvider } = await import('./providers.js');
        return await callProvider(resolved.provider, resolved.apiKey, {
          system: req.system,
          user: req.user,
          maxTokens: req.maxTokens,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[aiProxy] BYOK provider (${resolved.provider}) failed — falling back to built-in:`,
          (err as Error).message,
        );
        // fall through to built-in
      }
    }
  }
  return callBuiltin(req);
}
