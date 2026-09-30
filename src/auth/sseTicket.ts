import { randomBytes } from 'node:crypto';
import type { JwtClaims } from './jwt.js';

/**
 * Short-lived, single-use tickets for EventSource (SSE-over-GET) connections.
 * The browser can't set an Authorization header on EventSource, and putting the
 * 12 h JWT in the URL leaked it into proxy access logs and browser history. A
 * ticket is minted with the bearer token (POST /api/auth/sse-ticket), is valid
 * for TICKET_TTL_MS and works exactly once. In-memory: the API is one process.
 */
const TICKET_TTL_MS = 60_000;
const tickets = new Map<string, { claims: JwtClaims; exp: number }>();

export function issueSseTicket(claims: JwtClaims, now = Date.now()): string {
  for (const [t, v] of tickets) if (v.exp <= now) tickets.delete(t);
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { claims, exp: now + TICKET_TTL_MS });
  return ticket;
}

/** Returns the claims and burns the ticket; null if unknown, used or expired. */
export function consumeSseTicket(ticket: string, now = Date.now()): JwtClaims | null {
  const v = tickets.get(ticket);
  if (!v) return null;
  tickets.delete(ticket);
  return v.exp > now ? v.claims : null;
}
