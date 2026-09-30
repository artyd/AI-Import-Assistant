import { describe, expect, it } from 'vitest';
import { consumeSseTicket, issueSseTicket } from '../sseTicket.js';

describe('SSE tickets', () => {
  const claims = { sub: 'u1', email: 'a@b.c' };
  it('works exactly once', () => {
    const t = issueSseTicket(claims, 1000);
    expect(consumeSseTicket(t, 1500)).toEqual(claims);
    expect(consumeSseTicket(t, 1600)).toBeNull();
  });
  it('expires after 60 s and rejects unknown tickets', () => {
    const t = issueSseTicket(claims, 0);
    expect(consumeSseTicket(t, 61_000)).toBeNull();
    expect(consumeSseTicket('nope')).toBeNull();
  });
});
