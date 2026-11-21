import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { peekCtx } from './auth.js';

export interface RateLimitOptions {
  windowMs: number;
  ipMax: number;
  userMax: number;
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
  const common = {
    windowMs,
    standardHeaders: 'draft-7' as const,
    legacyHeaders: false,
    message: { error: 'too many requests' },
  };
  const ipLimiter = rateLimit({
    ...common,
    limit: overrides.ipMax ?? config.rateLimitIpMax,
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
  });
  const userLimiter = rateLimit({
    ...common,
    limit: overrides.userMax ?? config.rateLimitUserMax,
    keyGenerator: (req) => {
      const ctx = peekCtx(req);
      return ctx ? `user:${ctx.userId}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
    },
  });
  return { ipLimiter, userLimiter };
}
