import { describe, expect, it } from 'vitest';
import { isFinalFailure } from '../failurePolicy.js';

describe('isFinalFailure', () => {
  it('is false while attempts remain', () => {
    expect(isFinalFailure(1, 3)).toBe(false);
    expect(isFinalFailure(2, 3)).toBe(false);
  });
  it('is true on the last attempt', () => {
    expect(isFinalFailure(3, 3)).toBe(true);
    expect(isFinalFailure(4, 3)).toBe(true);
  });
  it('defaults to a single attempt', () => {
    expect(isFinalFailure(1, undefined)).toBe(true);
  });
});
