import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface JwtClaims {
  sub: string; // user id
  email: string;
}

export function signToken(claims: JwtClaims): string {
  return jwt.sign(claims, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): JwtClaims {
  const decoded = jwt.verify(token, config.JWT_SECRET);
  if (typeof decoded === 'string') throw new Error('Malformed token');
  return { sub: String(decoded.sub), email: String(decoded.email) };
}
