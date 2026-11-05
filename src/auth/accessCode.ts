import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../lib/config.js';

/**
 * The shared team PIN (ACCESS_CODE). It opens Штурман (POST /api/auth/login-code)
 * and unlocks editing in Поставки (POST /api/supply/unlock). Both endpoints share
 * the throttles in loginThrottle.ts.
 */

/** PIN login is on when a 6–8 digit PIN is configured. */
export function codeLoginEnabled(): boolean {
  return /^\d{6,8}$/.test(config.ACCESS_CODE);
}

/** Constant-time PIN comparison (hash first so lengths always match). */
export function codeMatches(input: string): boolean {
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(config.ACCESS_CODE).digest();
  return timingSafeEqual(a, b);
}
