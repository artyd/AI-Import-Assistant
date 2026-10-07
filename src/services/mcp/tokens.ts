import { createHash, randomBytes } from 'node:crypto';
import { query } from '../../db/pool.js';

/**
 * Personal MCP access tokens. One active token per user; issuing a new one
 * replaces (revokes) the previous. Only the SHA-256 hash is stored — the raw
 * token is returned once, from `issueMcpToken`, and lives in the user's MCP
 * client config as part of the connector URL (`/api/mcp/<token>`).
 */

const TOKEN_PREFIX = 'shm_';

export interface McpTokenStatus {
  exists: boolean;
  /** Last 4 chars of the token, to recognise it in a client config. */
  hint: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function getMcpTokenStatus(userId: string): Promise<McpTokenStatus> {
  const { rows } = await query<{ token_hint: string; created_at: Date; last_used_at: Date | null }>(
    'SELECT token_hint, created_at, last_used_at FROM mcp_tokens WHERE user_id = $1',
    [userId],
  );
  const row = rows[0];
  if (!row) return { exists: false, hint: null, createdAt: null, lastUsedAt: null };
  return {
    exists: true,
    hint: row.token_hint,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  };
}

/** Creates (or rotates) the user's token and returns the raw value once. */
export async function issueMcpToken(userId: string): Promise<{ token: string; status: McpTokenStatus }> {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const hint = token.slice(-4);
  await query(
    `INSERT INTO mcp_tokens (user_id, token_hash, token_hint)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash, token_hint = EXCLUDED.token_hint,
           created_at = now(), last_used_at = NULL`,
    [userId, hashToken(token), hint],
  );
  return { token, status: await getMcpTokenStatus(userId) };
}

export async function revokeMcpToken(userId: string): Promise<void> {
  await query('DELETE FROM mcp_tokens WHERE user_id = $1', [userId]);
}

/** Resolves a raw token to its owner (and stamps last use), or null. */
export async function resolveMcpToken(token: string): Promise<string | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 128) return null;
  const { rows } = await query<{ user_id: string }>(
    `UPDATE mcp_tokens SET last_used_at = now()
     WHERE token_hash = $1
     RETURNING user_id`,
    [hashToken(token)],
  );
  return rows[0]?.user_id ?? null;
}
