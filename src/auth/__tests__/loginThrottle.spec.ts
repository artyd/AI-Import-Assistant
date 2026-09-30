import { describe, expect, it } from 'vitest';
import { clearLoginFailures, isEmailLocked, recordLoginFailure } from '../loginThrottle.js';

describe('login lockout', () => {
  it('locks an email after 8 failures within the window, case-insensitively', () => {
    const t = 1_000_000;
    for (let i = 0; i < 7; i++) recordLoginFailure('Boss@Example.com', t);
    expect(isEmailLocked('boss@example.com', t)).toBe(false);
    recordLoginFailure('boss@example.com', t);
    expect(isEmailLocked('BOSS@example.com', t)).toBe(true);
  });

  it('unlocks after the window and on successful login', () => {
    const t = 5_000_000;
    for (let i = 0; i < 8; i++) recordLoginFailure('a@b.c', t);
    expect(isEmailLocked('a@b.c', t + 16 * 60 * 1000)).toBe(false);
    for (let i = 0; i < 8; i++) recordLoginFailure('x@y.z', t);
    clearLoginFailures('x@y.z');
    expect(isEmailLocked('x@y.z', t)).toBe(false);
  });
});
