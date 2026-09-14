import { query } from '../db/pool.js';
import { encryptSecret, decryptSecret, byokEnabled } from './aiProxy/crypto.js';
import type { AiProvider } from './aiProxy/providers.js';

/**
 * Per-user AI config (Phase E — BYOK). Reads/writes `ai_configs` and produces the
 * browser-safe view: engine + provider + whether a key is stored + a masked tail.
 * The raw/encrypted key is NEVER returned to the caller.
 */

export type AiEngine = 'builtin' | 'byok';

/** Public shape returned by GET/PUT — never carries a raw or encrypted key. */
export interface AiConfigView {
  engine: AiEngine;
  provider: AiProvider | null;
  hasKey: boolean;
  keyMask: string | null;
}

interface AiConfigRow {
  engine: string;
  provider: string | null;
  enc_key: string | null;
}

/** Mask a decrypted key as `••••1234` (last 4 chars), or null if unavailable. */
function maskKey(encKey: string | null): string | null {
  if (!encKey || !byokEnabled()) return null;
  try {
    const plain = decryptSecret(encKey);
    if (!plain) return null;
    return `••••${plain.slice(-4)}`;
  } catch {
    return null;
  }
}

function toView(row: AiConfigRow | undefined): AiConfigView {
  if (!row) return { engine: 'builtin', provider: null, hasKey: false, keyMask: null };
  return {
    engine: row.engine === 'byok' ? 'byok' : 'builtin',
    provider: (row.provider as AiProvider | null) ?? null,
    hasKey: Boolean(row.enc_key),
    keyMask: maskKey(row.enc_key),
  };
}

export async function getAiConfig(userId: string): Promise<AiConfigView> {
  const { rows } = await query<AiConfigRow>(
    'SELECT engine, provider, enc_key FROM ai_configs WHERE user_id = $1',
    [userId],
  );
  return toView(rows[0]);
}

export interface SaveAiConfigInput {
  engine: AiEngine;
  provider?: AiProvider;
  /** Plaintext provider key (encrypted before storage); omitted to keep existing. */
  key?: string;
}

/** True when the user already has a stored (encrypted) key. */
async function hasStoredKey(userId: string): Promise<boolean> {
  const { rows } = await query<{ enc_key: string | null }>(
    'SELECT enc_key FROM ai_configs WHERE user_id = $1',
    [userId],
  );
  return Boolean(rows[0]?.enc_key);
}

export type SaveAiConfigResult =
  | { ok: true; view: AiConfigView }
  | { ok: false; error: 'byok_disabled' | 'provider_required' | 'key_required' };

export async function saveAiConfig(
  userId: string,
  input: SaveAiConfigInput,
): Promise<SaveAiConfigResult> {
  if (input.engine === 'builtin') {
    // Reset to built-in: clear provider + key.
    await query(
      `INSERT INTO ai_configs (user_id, engine, provider, enc_key, updated_at)
       VALUES ($1, 'builtin', NULL, NULL, now())
       ON CONFLICT (user_id) DO UPDATE
         SET engine = 'builtin', provider = NULL, enc_key = NULL, updated_at = now()`,
      [userId],
    );
    return { ok: true, view: await getAiConfig(userId) };
  }

  // engine === 'byok'
  if (!byokEnabled()) return { ok: false, error: 'byok_disabled' };
  if (!input.provider) return { ok: false, error: 'provider_required' };

  let encKey: string | null = null;
  if (input.key) {
    encKey = encryptSecret(input.key);
  } else if (!(await hasStoredKey(userId))) {
    return { ok: false, error: 'key_required' };
  }

  if (encKey) {
    await query(
      `INSERT INTO ai_configs (user_id, engine, provider, enc_key, updated_at)
       VALUES ($1, 'byok', $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE
         SET engine = 'byok', provider = $2, enc_key = $3, updated_at = now()`,
      [userId, input.provider, encKey],
    );
  } else {
    // Keep the existing stored key, just switch engine/provider.
    await query(
      `UPDATE ai_configs SET engine = 'byok', provider = $2, updated_at = now()
       WHERE user_id = $1`,
      [userId, input.provider],
    );
  }
  return { ok: true, view: await getAiConfig(userId) };
}
