import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../../config.js';

/**
 * AES-256-GCM at-rest encryption for BYOK provider keys (Phase E). The symmetric
 * key comes from `BYOK_ENC_KEY` (base64 or hex → 32 bytes). Ciphertext is
 * serialized as base64 of `iv(12) | authTag(16) | ciphertext`.
 *
 * The raw key never leaves the server: we store only the blob and return only a
 * masked tail (last 4 chars) to the browser.
 */

const IV_LEN = 12;
const TAG_LEN = 16;

/** Parse BYOK_ENC_KEY (base64 or hex) into a 32-byte key, or throw a clear error. */
function loadKey(): Buffer {
  const raw = config.BYOK_ENC_KEY.trim();
  if (!raw) {
    throw new Error('BYOK_ENC_KEY is not set — BYOK is disabled.');
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new Error(
      `BYOK_ENC_KEY must decode to exactly 32 bytes (got ${key.length}); provide 32 bytes as base64 or 64 hex chars.`,
    );
  }
  return key;
}

/** Encrypt a plaintext secret → base64 blob (iv | authTag | ciphertext). */
export function encryptSecret(plain: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Decrypt a base64 blob (iv | authTag | ciphertext) → plaintext secret. */
export function decryptSecret(blob: string): string {
  const key = loadKey();
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('Malformed encrypted secret.');
  }
  const iv = buf.subarray(0, IV_LEN);
  const authTag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** True when BYOK_ENC_KEY is present and valid (32 bytes) — i.e. BYOK is enabled. */
export function byokEnabled(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}
