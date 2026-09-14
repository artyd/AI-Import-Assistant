import { describe, it, expect, vi } from 'vitest';

// Mock config so the crypto module never loads real env (no process.exit, no
// network). A valid 64-hex BYOK_ENC_KEY decodes to 32 bytes → BYOK enabled.
vi.mock('../../../config.js', () => ({
  config: {
    BYOK_ENC_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  },
}));

import { encryptSecret, decryptSecret, byokEnabled } from '../crypto.js';

describe('aiProxy crypto (AES-256-GCM, Phase E)', () => {
  it('reports BYOK enabled for a valid 32-byte key', () => {
    expect(byokEnabled()).toBe(true);
  });

  it('round-trips a secret and produces a fresh IV each time', () => {
    const secret = 'sk-test-1234567890';
    const blobA = encryptSecret(secret);
    const blobB = encryptSecret(secret);
    expect(blobA).not.toBe(blobB); // random IV per encryption
    expect(decryptSecret(blobA)).toBe(secret);
    expect(decryptSecret(blobB)).toBe(secret);
  });

  it('rejects a tampered blob (auth tag mismatch)', () => {
    const blob = encryptSecret('sk-abc');
    const buf = Buffer.from(blob, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decryptSecret(buf.toString('base64'))).toThrow();
  });
});
