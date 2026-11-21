import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { isIP } from 'node:net';
import type { Request, RequestHandler } from 'express';
import { config } from '../config.js';
import { peekCtx } from './auth.js';

export interface RateLimitOptions {
  windowMs: number;
  ipMax: number;
  userMax: number;
  /** Override of config.trustCfConnectingIp (tests). */
  trustCfConnectingIp: boolean;
}

/**
 * Client address used for IP rate-limit keys. With trustCf on and a single
 * valid CF-Connecting-IP value it is that header; anything else (flag off,
 * missing, repeated, comma-separated, not an IP) falls back to req.ip.
 * Traefik does not trust Cloudflare edge addresses, so behind Cloudflare
 * req.ip is the edge node for every user; the header carries the real client.
 */
export function clientAddress(req: Request, trustCf: boolean): string {
  if (trustCf) {
    const raw = req.headers['cf-connecting-ip'];
    if (typeof raw === 'string') {
      const v = raw.trim();
      // isIP rejects comma lists (repeated headers are joined with ", ").
      if (isIP(v) !== 0) return v;
    }
  }
  return req.ip ?? '';
}

/**
 * Two in-memory limiters for the /api route group.
 *  - ipLimiter runs before auth, keyed by client IP (IPv6 collapsed to a /56).
 *  - userLimiter runs after auth, keyed by the internal user id, falling back to
 *    the IP if no auth context is present.
 * The store is per process: with N replicas the effective budget is N times
 * larger. The service runs a single replica.
 */
export function createApiLimiters(overrides: Partial<RateLimitOptions> = {}): {
  ipLimiter: RequestHandler;
  userLimiter: RequestHandler;
} {
  const windowMs = overrides.windowMs ?? config.rateLimitWindowMs;
  const trustCf = overrides.trustCfConnectingIp ?? config.trustCfConnectingIp;
  const ipKey = (req: Request): string => `ip:${ipKeyGenerator(clientAddress(req, trustCf))}`;
  const common = {
    windowMs,
    standardHeaders: 'draft-7' as const,
    legacyHeaders: false,
    message: { error: 'too many requests' },
  };
  const ipLimiter = rateLimit({
    ...common,
    limit: overrides.ipMax ?? config.rateLimitIpMax,
    keyGenerator: ipKey,
  });
  const userLimiter = rateLimit({
    ...common,
    limit: overrides.userMax ?? config.rateLimitUserMax,
    keyGenerator: (req) => {
      const ctx = peekCtx(req);
      return ctx ? `user:${ctx.userId}` : ipKey(req);
    },
  });
  return { ipLimiter, userLimiter };
}
