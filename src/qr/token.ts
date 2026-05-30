import { randomBytes, randomUUID } from 'node:crypto';
import { sha256 } from '../telegram/initData.js';

export interface MintedToken {
  jti: string;
  token: string; // opaque, returned to the client only
  tokenHash: Buffer; // SHA-256, the only thing persisted
}

/**
 * Mint a fresh opaque QR token. The raw token is high-entropy random bytes;
 * the database only ever stores its SHA-256 hash, so a DB leak cannot be
 * replayed and the token cannot be reverse-engineered.
 */
export function mintToken(): MintedToken {
  const token = randomBytes(32).toString('base64url');
  return { jti: randomUUID(), token, tokenHash: sha256(token) };
}

export function hashToken(token: string): Buffer {
  return sha256(token);
}
