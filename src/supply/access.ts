import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../lib/config.js';
import { verifyToken } from '../auth/jwt.js';

/**
 * Who may write to Поставки: a Штурман session (its normal JWT) or anyone who
 * unlocked editing with the Штурман PIN. The PIN unlock returns a supply token
 * signed with a DIFFERENT key, so `authenticate` (Штурман routes) rejects it —
 * unlocking Поставки never opens Штурман.
 */

const SUPPLY_SCOPE = 'supply';
const SUPPLY_TTL = '12h';

function supplyKey(): string {
  return `${config.JWT_SECRET}:${SUPPLY_SCOPE}`;
}

export function signSupplyToken(): { token: string; expiresAt: string } {
  const token = jwt.sign({ scope: SUPPLY_SCOPE }, supplyKey(), { expiresIn: SUPPLY_TTL });
  const decoded = jwt.decode(token) as { exp?: number } | null;
  return { token, expiresAt: new Date((decoded?.exp ?? 0) * 1000).toISOString() };
}

export function verifySupplyToken(token: string): boolean {
  try {
    const decoded = jwt.verify(token, supplyKey());
    return typeof decoded === 'object' && decoded !== null && (decoded as { scope?: unknown }).scope === SUPPLY_SCOPE;
  } catch {
    return false;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    supplyActor?: string;
  }
}

/** The editor behind a request, or null for a viewer. Never throws. */
export function supplyEditor(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;
  if (verifySupplyToken(token)) return 'Код Штурмана';
  try {
    return verifyToken(token).email || 'Штурман';
  } catch {
    return null;
  }
}

/** preHandler for every Поставки write. */
export async function requireSupplyEditor(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const actor = supplyEditor(req);
  if (!actor) {
    await reply.code(401).send({ error: 'unauthorized', message: 'Editing needs the Штурман code' });
    return;
  }
  req.supplyActor = actor;
}
